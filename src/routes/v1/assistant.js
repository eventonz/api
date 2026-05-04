/**
 * Assistant — RAG chat for event Assistants (Race Day Assistant).
 *
 * Mirrors API/api/v4/modules/assistant.cfm and assistant_report.cfm:
 *
 *   GET  /v1/assistant/:uuid           public config
 *   POST /v1/assistant/:uuid           chat: embed -> pgvector search -> LLM
 *   POST /v1/assistant/report          { race_id, content } -> assistant_reports
 *
 * Data lives in two databases:
 *   aievento DB (separate pool):  Assistant, Message, langchain_pg_embedding
 *   evento_pool DB (main pool):   assistant_reports
 *
 * Env vars required for chat:
 *   OPENAI_API_KEY        embeddings
 *   OPENROUTER_API_KEY    LLM
 *   OPENROUTER_MODEL      e.g. "openrouter/auto" or a specific model id
 */

const pool   = require('../../config/database');
const aiPool = require('../../config/aievento_database');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const TOP_K           = 5;
const HISTORY_LIMIT   = 10;

async function assistantRoutes(app) {
  // ---------------------------------------------------------------------------
  // POST /v1/assistant/report — store assistant feedback / report
  // Registered before /:uuid to avoid the param route swallowing "report".
  // ---------------------------------------------------------------------------
  app.post('/report', {
    schema: {
      body: {
        type: 'object',
        properties: {
          race_id: { type: 'integer' },
          content: { type: 'string' },
        },
        required: ['race_id', 'content'],
      },
    },
  }, async (request, reply) => {
    const { race_id, content } = request.body;
    await pool.query(
      'INSERT INTO assistant_reports (race_id, message) VALUES ($1, $2)',
      [race_id, content]
    );
    return reply.code(201).send({ message: 'Record Created' });
  });

  // ---------------------------------------------------------------------------
  // GET /v1/assistant/:uuid — public config
  // ---------------------------------------------------------------------------
  app.get('/:uuid', {
    schema: {
      params: {
        type: 'object',
        properties: { uuid: { type: 'string', minLength: 10 } },
        required: ['uuid'],
      },
    },
  }, async (request, reply) => {
    const { uuid } = request.params;

    const { rows } = await aiPool.query(
      `SELECT id, status, title, color, "messageLimit", "messageCount", expires
         FROM "Assistant"
        WHERE id = $1
        LIMIT 1`,
      [uuid]
    );

    if (rows.length === 0) {
      return reply.code(400).send({ errors: ['AI assistant not found'] });
    }

    const a = rows[0];
    const expiresOk    = !a.expires || new Date(a.expires) > new Date();
    const limitOk      = a.messageLimit === 0 || a.messageCount < a.messageLimit;
    const isActive     = a.status === 'active' && expiresOk && limitOk;
    const title        = (a.title || '').trim();
    const color        = (a.color || '').trim() || '#E8622A';
    const initialMsg   = title
      ? `Hello! I'm the assistant for ${title}. How can I help?`
      : `Hello! How can I help you today?`;

    return reply.send({
      status:         isActive ? 'active' : 'inactive',
      initialMessage: initialMsg,
      title,
      color,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /v1/assistant/:uuid — chat (RAG)
  // ---------------------------------------------------------------------------
  app.post('/:uuid', {
    schema: {
      params: {
        type: 'object',
        properties: { uuid: { type: 'string', minLength: 10 } },
        required: ['uuid'],
      },
      body: {
        type: 'object',
        properties: {
          message:  { type: 'string', minLength: 1 },
          messages: { type: 'array' },
          source:   { type: 'string' },
        },
        required: ['message'],
      },
    },
  }, async (request, reply) => {
    const { uuid } = request.params;
    const userMessage = request.body.message.trim();
    const prevMessages = Array.isArray(request.body.messages) ? request.body.messages : [];

    if (!userMessage) {
      return reply.code(400).send({ errors: ['message is required'] });
    }

    // 1. Validate assistant
    const { rows } = await aiPool.query(
      `SELECT id, status, "messageCount", "messageLimit", expires
         FROM "Assistant"
        WHERE id = $1
        LIMIT 1`,
      [uuid]
    );
    if (rows.length === 0) {
      return reply.code(400).send({ errors: ['AI assistant not found'] });
    }
    const a = rows[0];
    if (a.status !== 'active') {
      return reply.code(400).send({ errors: ['AI assistant is not active'] });
    }
    if (a.expires && new Date(a.expires) < new Date()) {
      return reply.code(400).send({ errors: ['AI assistant subscription has expired'] });
    }
    if (a.messageLimit !== 0 && a.messageCount >= a.messageLimit) {
      return reply.code(400).send({ errors: ['AI assistant message limit reached'] });
    }

    // 2. Embed user message
    let embeddingVector;
    try {
      const embRes = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: userMessage }),
      });
      if (!embRes.ok) throw new Error(`embedding ${embRes.status}`);
      const embData = await embRes.json();
      embeddingVector = embData.data[0].embedding;
    } catch (err) {
      console.error('[assistant] embedding failed:', err.message);
      return reply.code(500).send({ errors: ['Failed to generate embedding'] });
    }

    // 3. pgvector similarity search (vector literal must be inlined; numbers are
    //    safe because they come from OpenAI, not user input)
    const vectorStr = `[${embeddingVector.join(',')}]`;
    const { rows: chunks } = await aiPool.query(
      `SELECT content,
              metadata,
              1 - (embedding <=> '${vectorStr}'::vector) AS similarity
         FROM langchain_pg_embedding
        WHERE metadata->>'assistantId' = $1
        ORDER BY embedding <=> '${vectorStr}'::vector
        LIMIT ${TOP_K}`,
      [uuid]
    );

    const retrievedContent = chunks
      .map((c) => (c.content || '').trim())
      .filter(Boolean)
      .join('\n\n');

    // 4. Build LLM messages
    const systemPrompt =
      'You are the official assistant for this event. Answer questions ONLY based on the provided event information below.\n\n' +
      'CRITICAL RULES:\n' +
      '1. ONLY use information explicitly provided in the Event Information below.\n' +
      '2. NEVER make up links, URLs, or information not in the provided content.\n' +
      '3. If a link is mentioned in the provided content, use that EXACT link.\n' +
      '4. If no link is provided, do NOT create or suggest any links.\n' +
      '5. If the information is not in the provided content, say "I don\'t have specific information about that."\n' +
      '6. Do not reference events or locations not mentioned in the provided content.\n' +
      '7. When your answer refers to a specific map location (e.g. a bag drop, aid station, checkpoint), append [POI:exact title] immediately after mentioning it, using the exact title from the Event Information. Example: "The bag drop [POI:Bag Drop Area] is near the start line." Only tag locations that appear in the Event Information.\n\n' +
      'Event Information:\n' +
      retrievedContent;

    const recentHistory = prevMessages
      .filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string')
      .slice(-HISTORY_LIMIT);

    const llmMessages = [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
      { role: 'user', content: userMessage },
    ];

    // 5. Call OpenRouter
    let aiResponse;
    try {
      const llmRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          model:       process.env.OPENROUTER_MODEL,
          messages:    llmMessages,
          temperature: 0.7,
          max_tokens:  1000,
        }),
      });
      if (!llmRes.ok) throw new Error(`llm ${llmRes.status}`);
      const llmData = await llmRes.json();
      aiResponse = llmData.choices?.[0]?.message?.content;
      if (!aiResponse) throw new Error('empty LLM response');
    } catch (err) {
      console.error('[assistant] LLM failed:', err.message);
      return reply.code(500).send({ errors: ['Failed to get AI response'] });
    }

    // 6. Persist Message + bump count
    const { rows: saved } = await aiPool.query(
      `INSERT INTO "Message" (id, content, response, "assistantId", "createdAt")
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())
       RETURNING id`,
      [userMessage, aiResponse, uuid]
    );

    await aiPool.query(
      'UPDATE "Assistant" SET "messageCount" = "messageCount" + 1 WHERE id = $1',
      [uuid]
    );

    return reply.send({
      response:     aiResponse,
      messageCount: a.messageCount + 1,
      messageId:    saved[0].id,
    });
  });
}

module.exports = assistantRoutes;

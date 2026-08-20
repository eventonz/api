module.exports = {
  apps: [
    {
      name: 'evento-api',
      script: './src/server.js',

      // Cluster mode: 2 workers (droplet has 2 vCPUs as of the 2-core upgrade).
      // Use 'max' instead to auto-track core count if the droplet is resized again.
      instances: 2,
      exec_mode: 'cluster',

      // Auto-restart on crash
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',

      // Zero-downtime deploys
      wait_ready: true,       // wait for process.send('ready') before considering started
      listen_timeout: 10000,  // ms to wait for ready signal
      kill_timeout: 5000,     // ms to allow graceful shutdown before SIGKILL

      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000,
      },

      // Log management
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      out_file: '/var/log/evento-api/out.log',
      error_file: '/var/log/evento-api/error.log',
    },
    {
      name: 'evento-analytics-worker',
      script: './src/workers/analyticsWorker.js',

      // Single instance: the 15-min rollup must not run concurrently, and one
      // process drains the queue far faster than events arrive.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      kill_timeout: 5000,

      env: { NODE_ENV: 'production' },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      out_file: '/var/log/evento-api/analytics-out.log',
      error_file: '/var/log/evento-api/analytics-error.log',
    },
    {
      name: 'evento-track-worker',
      script: './src/workers/trackWorker.js',

      // Fork mode, multiple instances for parallel queue consumption
      instances: 2,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      kill_timeout: 5000,

      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      out_file: '/var/log/evento-api/worker-out.log',
      error_file: '/var/log/evento-api/worker-error.log',
    },
  ],
};

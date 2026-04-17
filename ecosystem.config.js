module.exports = {
  apps: [
    {
      name: 'evento-api',
      script: './src/server.js',

      // Cluster mode: one worker per CPU core
      instances: 'max',
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
  ],
};

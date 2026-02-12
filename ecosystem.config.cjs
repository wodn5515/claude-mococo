module.exports = {
  apps: [{
    name: 'claude-mococo',
    script: 'node_modules/.bin/tsx',
    args: 'src/index.ts',
    interpreter: 'none',

    // Process
    instances: 1,
    exec_mode: 'fork',
    watch: false,

    // Stability
    max_memory_restart: '500M',
    max_restarts: 10,
    min_uptime: '10s',

    // Logs
    output: 'logs/pm2-out.log',
    error: 'logs/pm2-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

    // Graceful shutdown (Discord connection cleanup)
    kill_timeout: 5000,
    listen_timeout: 3000,
    shutdown_with_message: true,
  }],
};

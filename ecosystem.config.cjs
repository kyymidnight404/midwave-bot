module.exports = {
  apps: [
    {
      name: 'midwave-bot',
      script: 'src/index.js',
      node_args: '--env-file=.env',
      // Must remain 1 instance in fork mode for consistent in-memory lobbies, locks, and RAM AI contexts.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

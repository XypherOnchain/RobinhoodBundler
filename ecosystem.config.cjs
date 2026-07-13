/**
 * PM2 process file — run all three bots on a VPS.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: "noxa-bundler",
      script: "server.js",
      cwd: __dirname,
      env: {
        DASHBOARD_MODE: "bundler",
        PORT: "3847",
        NODE_ENV: "production",
      },
      max_memory_restart: "512M",
      restart_delay: 2000,
      exp_backoff_restart_delay: 1000,
    },
    {
      name: "noxa-sniper",
      script: "sniper-server.js",
      cwd: __dirname,
      env: {
        DASHBOARD_MODE: "sniper",
        PORT: "3848",
        ENABLE_SNIPER: "1",
        NODE_ENV: "production",
      },
      max_memory_restart: "512M",
      restart_delay: 2000,
      exp_backoff_restart_delay: 1000,
    },
    {
      name: "noxa-txbot",
      script: "txbot-server.js",
      cwd: __dirname,
      env: {
        DASHBOARD_MODE: "txbot",
        PORT: "3849",
        ENABLE_TXBOT: "1",
        NODE_ENV: "production",
      },
      max_memory_restart: "256M",
      restart_delay: 2000,
      exp_backoff_restart_delay: 1000,
    },
  ],
};

module.exports = {
  apps: [
    {
      name: 'discordbot',
      script: 'index.js',
      watch: true,
      ignore_watch: ['node_modules', '.git', 'api_usage.json'],
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

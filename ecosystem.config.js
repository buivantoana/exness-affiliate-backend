module.exports = {
  apps: [
    {
      name: "exness-backend",
      script: "server/index.js",
      instances: 1,
      env_production: {
        NODE_ENV: "production",
        PORT: 3000
      }
    }
  ]
};

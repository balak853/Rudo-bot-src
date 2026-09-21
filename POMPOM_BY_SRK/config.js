// config.js - Bot Configuration
// Keep non-secret bot settings here. BOT_TOKEN must stay in Render Secrets.

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  BOT_TOKEN: requiredEnv("BOT_TOKEN"),
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID || "8211458794",
  UPI_ID: process.env.UPI_ID || "shreyas19k@fam",
  UPI_NAME: process.env.UPI_NAME || "OG SUPSCRIPTION",
};

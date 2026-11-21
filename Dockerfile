FROM node:22.12.0-slim
WORKDIR /bot
COPY main.mjs bot.mjs map.mjs ./
ENTRYPOINT ["node", "/bot/main.mjs"]

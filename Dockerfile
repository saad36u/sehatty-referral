# باك-إند بدون أي مكتبات خارجية — صورة صغيرة تكفي
FROM node:22-alpine

WORKDIR /app

# لا توجد تبعيات، لكن ننسخ package.json أولاً للاستفادة من طبقات الكاش
COPY package.json ./

COPY . .

# Render يمرر المنفذ عبر متغير PORT
ENV PORT=3000
EXPOSE 3000

USER node

CMD ["node", "server/server.js"]

FROM node:20-alpine
ENV NODE_ENV=production TZ=America/Phoenix DATA_DIR=/data PORT=3000
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]

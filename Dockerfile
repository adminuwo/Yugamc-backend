FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 5000
CMD [ "node", "server.js" ]

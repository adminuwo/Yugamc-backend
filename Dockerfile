# Use long-term support version of Node.js
FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

RUN npm install --production

# If your project uses pdf-parse or gems that need extra libs:
# RUN apt-get update && apt-get install -y <dependencies>

# Bundle app source
COPY . .

# Root directory files that shouldn't be in the image are handled by .dockerignore
# But we should ensure we don't copy node_modules from local
# (Already handled by copy command + .dockerignore)

EXPOSE 5000

CMD [ "node", "server.js" ]

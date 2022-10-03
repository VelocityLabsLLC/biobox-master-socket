FROM node:15-alpine


WORKDIR /usr/app
COPY package.json .
COPY package-lock.json .


RUN npm i --quiet

COPY . .
# RUN npm run build
CMD ["npm","run","start"]

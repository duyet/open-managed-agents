FROM node:22-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npx tsc

FROM node:22-slim AS run
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 8100
CMD ["node", "dist/index.js"]

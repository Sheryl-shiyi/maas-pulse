FROM node:20-alpine AS build

WORKDIR /app
COPY package.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install --workspaces --include-workspace-root

COPY server/ server/
COPY client/ client/
RUN npm run build -w client
RUN npm run build -w server

FROM node:20-alpine AS runtime

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist/ server/dist/
COPY --from=build /app/client/dist/ client/dist/
COPY --from=build /app/node_modules/ node_modules/

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER 1001
CMD ["node", "server/dist/index.js"]

# Runs the self-contained bundle from `pnpm agent:build` (agent/dist/main.js);
# esbuild inlines every dependency, so the image needs no node_modules.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY dist/main.js ./main.js
USER node
CMD ["node", "main.js"]

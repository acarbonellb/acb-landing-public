# Runs the self-contained bundle from `pnpm agent:build` (agent/dist/main.js);
# esbuild inlines every dependency, so the image needs no node_modules. The
# base is pinned by version and digest because the deploy rebuilds the
# image: it builds on the same base the pull request's rehearsal built on.
# Bump both together.
FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production
WORKDIR /app
COPY dist/main.js ./main.js
USER node
CMD ["node", "main.js"]

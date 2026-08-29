# syntax=docker/dockerfile:1
FROM public.ecr.aws/docker/library/node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM public.ecr.aws/docker/library/node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# Amazon RDS trust bundle for verified TLS to Aurora.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/osb/rds-global-bundle.pem
RUN chmod 0444 /etc/osb/rds-global-bundle.pem
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY migrations ./migrations
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]

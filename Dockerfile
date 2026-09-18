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
# Offline place data (GeoNames, CC BY 4.0 — see NOTICE). Location resolution
# runs in-process; the switchboard never calls a geocoding service.
COPY data ./data
# The PhotoDNA SDK, if this build context has it. It is Microsoft-licensed and
# is not in the repository, so what lands here is whatever the deploy put in
# vendor/photodna on the way past (vendor/photodna/README.md). A build with
# only the README carries only the README, the loader finds no files, and the
# server reports PhotoDNA off rather than failing to start.
COPY vendor ./vendor
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]

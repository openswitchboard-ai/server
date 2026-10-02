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
# The known-image check's optional module, if this build context has it. It is
# not in the repository, so what lands here is whatever the deploy put in
# vendor/known-image on the way past (vendor/known-image/README.md). A build
# with only the README carries only the README and the server reports the
# check off. A build with ANYTHING else there must verify or the build fails:
# a deployment that carries a module that cannot work would hold every photo.
COPY vendor ./vendor
RUN node dist/scripts/safety/known-image-verify.mjs vendor/known-image
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]

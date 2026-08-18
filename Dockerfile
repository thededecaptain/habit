FROM node:22-alpine

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# GitHub repo root is shopify-app/; the Remix app lives in habit/.
COPY habit/package.json habit/package-lock.json habit/pnpm-workspace.yaml ./
COPY habit/extensions ./extensions

RUN npm ci --include=dev

COPY habit/ .

RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "docker-start"]

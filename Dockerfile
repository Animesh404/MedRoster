FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# prisma.config.ts eagerly resolves DATABASE_URL even for `prisma generate`,
# which never opens a database connection. Compose's `environment:` block
# only applies at container run time, so give the build a harmless
# build-time placeholder purely to satisfy that eager resolution.
ARG DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
ENV DATABASE_URL=${DATABASE_URL}
RUN npx prisma generate && npm run build
EXPOSE 3000

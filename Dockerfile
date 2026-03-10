FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=0

WORKDIR /opt/render/project/src

COPY package.json package-lock.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium

COPY . .

ENV HOST=0.0.0.0
ENV PORT=10000
ENV PLAYWRIGHT_HEADLESS=true

EXPOSE 10000

CMD ["npm", "start"]

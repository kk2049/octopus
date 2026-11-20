FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /opt/octopus-browser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 DISPLAY=:99
RUN npm install --ignore-scripts --no-audit --no-fund --save-exact playwright@1.62.1
COPY core.mjs tools.mjs service.mjs ./
USER 1000:1000
CMD ["/bin/sh", "-c", "Xvfb :99 -screen 0 1600x1200x24 -nolisten tcp & exec node service.mjs"]

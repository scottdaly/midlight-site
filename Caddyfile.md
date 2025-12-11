# Caddyfile for Midlight Site with Error Reporting Backend

To integrate the new error reporting backend with your Caddy server, you need to add a `handle /api/*` block that proxies requests to `localhost:3001` (where your Node.js backend should be running). This new block should be placed *before* your existing generic `handle` block that serves static files (`/var/www/midlight-site/dist`).

Here's the modified `Caddyfile` content:

```caddy
midlight.ai, www.midlight.ai {
    # NEW: Handle API requests for the error reporting backend
    handle /api/* {
        reverse_proxy localhost:3001
    }

    handle /releases/* {
        uri strip_prefix /releases
        root * /var/www/midlight-releases
        file_server browse
    }

    handle {
        root * /var/www/midlight-site/dist
        try_files {path} /index.html
        file_server
    }

    encode gzip zstd

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-XSS-Protection "1; mode=block"
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
    }

    @static {
        file
        path *.js *.css *.jpg *.png *.gif *.ico *.svg *.woff *.woff2
    }
    header @static Cache-Control "public, max-age=31536000"

    tls /etc/caddy/certs/midlight.ai.crt /etc/caddy/certs/midlight.ai.key
}
```

**Steps to apply this change:**

1.  **Update your Caddyfile**: Replace the content of your current `Caddyfile` on your Digital Ocean droplet with the one provided above.
2.  **Reload Caddy**: After updating the file, you'll need to reload Caddy to apply the changes. Typically, this can be done with a command like:
    ```bash
    sudo systemctl reload caddy
    ```
    (The exact command might vary based on your Caddy installation.)
3.  **Ensure Backend is Running**: Make sure your Node.js backend is running and managed by PM2 (or similar) on `localhost:3001` as described in the previous instructions.

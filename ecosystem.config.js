module.exports = {
    apps: [{
        name: "bgp-query-bot",
        script: "bun",
        args: "run dist/index.js",
        env: {
            NODE_ENV: "production",
        }
    }]
}
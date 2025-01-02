module.exports = {
    apps: [{
        name: "bgp-query-bot",
        script: "bun",
        args: "run start",
        env: {
            NODE_ENV: "production",
        }
    }]
}

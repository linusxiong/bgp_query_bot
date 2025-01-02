module.exports = {
    apps: [{
        name: "bgp-query-bot",
        script: "bun",
        args: "run start",
        interpreter: "bun",
        env: {
            NODE_ENV: "production",
            PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
        }
    }]
}

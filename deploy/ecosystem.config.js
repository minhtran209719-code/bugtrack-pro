// PM2 config: pm2 start deploy/ecosystem.config.js
module.exports = {
    apps: [{
        name: 'bugtrack',
        script: './server.js',
        cwd: __dirname + '/..',
        env: { NODE_ENV: 'production', PORT: 3000 },
        max_memory_restart: '500M',
        out_file: './logs/out.log',
        error_file: './logs/err.log',
        merge_logs: true,
        time: true,
    }],
};

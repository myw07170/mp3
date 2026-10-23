const { once } = require('node:events');

async function serve(t, app) {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(function () {
        return new Promise(function (resolve, reject) {
            server.close(function (error) {
                if (error) reject(error);
                else resolve();
            });
        });
    });
    return 'http://127.0.0.1:' + server.address().port;
}

module.exports = { serve };

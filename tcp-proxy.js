const net = require('net');
const tls = require('tls');
const fs = require('fs');
const util = require('util');

/**
 * Creates a new TCP proxy instance.
 * @param {number} proxyPort - Port to listen on.
 * @param {string|string[]|number} serviceHost - Host(s) to forward traffic to.
 * @param {string|string[]|number} servicePort - Port(s) to forward traffic to.
 * @param {Object} options - Configuration options.
 */
module.exports.createProxy = (proxyPort, serviceHost, servicePort, options) => {
    return new TcpProxy(proxyPort, serviceHost, servicePort, options);
};

function uniqueKey(socket) {
    return `${socket.remoteAddress}:${socket.remotePort}`;
}

function parse(o) {
    if (typeof o === 'string') {
        return o.split(',');
    } else if (typeof o === 'number') {
        return parse(o.toString());
    } else if (Array.isArray(o)) {
        return o;
    } else {
        throw new Error(`cannot parse object: ${o}`);
    }
}

class TcpProxy {
    constructor(proxyPort, serviceHost, servicePort, options) {
        this.proxyPort = proxyPort;
        this.serviceHosts = parse(serviceHost);
        this.servicePorts = parse(servicePort);
        this.serviceHostIndex = -1;
        this.options = this.parseOptions(options);

        this.proxyTlsOptions = {
            passphrase: this.options.passphrase,
            secureProtocol: 'TLSv1_2_method'
        };

        if (this.options.tls) {
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            this.proxyTlsOptions.pfx = fs.readFileSync(this.options.pfx);
        }

        this.serviceTlsOptions = {
            rejectUnauthorized: this.options.rejectUnauthorized,
            secureProtocol: 'TLSv1_2_method'
        };

        this.proxySockets = {};

        if (this.options.identUsers.length !== 0) {
            this.users = this.options.identUsers;
            this.log(`Will only allow these users: ${this.users.join(', ')}`);
        } else {
            this.log('Will allow all users');
        }

        if (this.options.allowedIPs.length !== 0) {
            this.allowedIPs = this.options.allowedIPs;
            this.log(`Will only allow these IPs: ${this.allowedIPs.join(', ')}`);
        }

        this.createListener();
    }

    parseOptions(options) {
        return Object.assign({
            quiet: true,
            pfx: require.resolve('./cert.pfx'),
            passphrase: 'abcd',
            rejectUnauthorized: true,
            identUsers: [],
            allowedIPs: []
        }, options);
    }

    createListener() {
        if (this.options.tls && (this.options.tls === 'both' || this.options.tls === 'client')) {
            this.server = tls.createServer(this.proxyTlsOptions, (socket) => {
                this.handleClientConnection(socket);
            });
        } else {
            this.server = net.createServer((socket) => {
                this.handleClientConnection(socket);
            });
        }
        this.server.listen(this.proxyPort, this.options.hostname);
    }

    handleClientConnection(socket) {
        if (this.users) {
            this.handleAuth(socket);
        } else {
            this.handleClient(socket);
        }
    }

    // RFC 1413 authentication
    handleAuth(proxySocket) {
        if (this.allowedIPs.includes(proxySocket.remoteAddress)) {
            this.handleClient(proxySocket);
            return;
        }

        const query = util.format('%d, %d', proxySocket.remotePort, this.proxyPort);
        const ident = new net.Socket();
        let resp = undefined;

        ident.on('error', (e) => {
            resp = false;
            ident.destroy();
        });

        ident.on('data', (data) => {
            resp = data.toString().trim();
            ident.destroy();
        });

        ident.on('close', () => {
            if (!resp) {
                this.log('No identd');
                proxySocket.destroy();
                return;
            }
            const user = resp.split(':').pop();
            if (!this.users.includes(user)) {
                this.log(`User "${user}" unauthorized`);
                proxySocket.destroy();
            } else {
                this.handleClient(proxySocket);
            }
        });

        ident.connect(113, proxySocket.remoteAddress, () => {
            ident.write(query);
            ident.end();
        });
    }

    handleClient(proxySocket) {
        const key = uniqueKey(proxySocket);
        this.log(`Connection from ${key}`);
        this.proxySockets[key] = proxySocket;

        const context = {
            buffers: [],
            connected: false,
            proxySocket: proxySocket
        };

        proxySocket.on('data', (data) => {
            this.handleUpstreamData(context, data);
        });

        proxySocket.on('close', () => {
            delete this.proxySockets[uniqueKey(proxySocket)];
            if (context.serviceSocket !== undefined) {
                context.serviceSocket.destroy();
            }
            this.log(`Disconnect client from ${uniqueKey(proxySocket)}`);
        });

        proxySocket.on('error', (e) => {
            if (context.serviceSocket !== undefined) {
                context.serviceSocket.destroy();
            }
            this.log(`Error client from ${uniqueKey(proxySocket)}`);
        });

        this.createServiceSocket(context);
    }

    async handleUpstreamData(context, data) {
        const processedData = await this.intercept(this.options.upstream, context, data);
        if (context.connected) {
            context.serviceSocket.write(processedData);
        } else {
            context.buffers.push(processedData);
            if (context.serviceSocket === undefined) {
                this.createServiceSocket(context);
            }
        }
    }

    createServiceSocket(context) {
        const options = this.parseServiceOptions(context);
        if (this.options.tls === 'both' || this.options.tls === 'server') {
            context.serviceSocket = tls.connect(options, () => {
                this.writeBuffer(context);
            });
        } else {
            context.serviceSocket = new net.Socket();
            context.serviceSocket.connect(options, () => {
                this.writeBuffer(context);
            });
        }

        context.serviceSocket.on('data', (data) => {
            this.intercept(this.options.downstream, context, data).then((processedData) => {
                context.proxySocket.write(processedData);
            });
        });

        context.serviceSocket.on('close', () => {
            if (context.proxySocket !== undefined) {
                context.proxySocket.destroy();
            }
            this.log(`Disconnect server for ${uniqueKey(context.proxySocket)}`);
        });

        context.serviceSocket.on('error', (e) => {
            this.log(`Error ${JSON.stringify(e)}, Proxy ${JSON.stringify(context.proxySocket)}`);
            if (context.proxySocket !== undefined) {
                context.proxySocket.destroy();
            }
            this.log(`Error server for ${uniqueKey(context.proxySocket)}`);
        });
    }

    parseServiceOptions(context) {
        const i = this.getServiceHostIndex(context.proxySocket);
        return Object.assign({
            port: this.servicePorts[parseInt(i, 10)],
            host: this.serviceHosts[parseInt(i, 10)],
            localAddress: this.options.localAddress,
            localPort: this.options.localPort
        }, this.serviceTlsOptions);
    }

    getServiceHostIndex(proxySocket) {
        this.serviceHostIndex++;
        if (this.serviceHostIndex === this.serviceHosts.length) {
            this.serviceHostIndex = 0;
        }
        let index = this.serviceHostIndex;
        if (this.options.serviceHostSelected) {
            index = this.options.serviceHostSelected(proxySocket, index);
        }
        return index;
    }

    writeBuffer(context) {
        context.connected = true;
        for (const buffer of context.buffers) {
            context.serviceSocket.write(buffer);
        }
        context.buffers = []; // Clear buffer after writing
    }

    end() {
        this.server.close();
        for (const key in this.proxySockets) {
            this.proxySockets[key].destroy();
        }
        this.server.unref();
    }

    log(msg) {
        if (!this.options.quiet) {
            console.log(msg);
        }
    }

    async intercept(interceptor, context, data) {
        if (interceptor) {
            return await interceptor(context, data);
        }
        return data;
    }
}

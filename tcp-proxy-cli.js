#!/usr/bin/env node
const { program } = require('commander');
const packageConfig = require('./package.json');

program
    .name('tcpproxy')
    .version(packageConfig.version)
    .description('A simple TCP proxy built using Node.js')
    .requiredOption('-p, --proxyPort <number>', 'Proxy port number', parseInt)
    .option('-h, --hostname [name]', 'Name or IP address of host')
    .requiredOption('-n, --serviceHost <name>',
        'Name or IP address of service host(s); if this is a comma separated list, performs round-robin load balancing')
    .requiredOption('-s, --servicePort <number>',
        'Service port number(s); if this is a comma separated list, it should have as many entries as serviceHost')
    .option('-m, --localAddress <address>', 'IP address of interface to use to connect to service')
    .option('-l, --localPort <port>', 'Port number to use to connect to service')
    .option('-q, --q', 'Be quiet', false)
    .option('-t, --tls [both|client|server]', 'Use TLS 1.2 with clients, server or both', false)
    .option('-u, --rejectUnauthorized [value]', 'Do not accept invalid certificate', 'true')
    .option('-c, --pfx [file]', 'Private key file', require.resolve("./cert.pfx"))
    .option('-a, --passphrase [value]', 'Passphrase to access private key file', 'abcd')
    .option('-i, --identUsers [user[,...]]', 'Comma-separated list of authorized users', '')
    .option('-A, --allowedIPs [ip1[,...]]', 'Comma-separated list of allowed IPs, overrides -i', '')
    .parse(process.argv);

const options = program.opts();

// Map CLI flags to internal option format used by the library
const proxyOptions = {
    ...options,
    quiet: options.q,
    rejectUnauthorized: options.rejectUnauthorized !== 'false',
    identUsers: options.identUsers === '' ? [] : options.identUsers.split(','),
    allowedIPs: options.allowedIPs === '' ? [] : options.allowedIPs.split(',')
};

const proxy = require("./tcp-proxy.js").createProxy(
    options.proxyPort,
    options.serviceHost,
    options.servicePort,
    proxyOptions
);

process.on('uncaughtException', (err) => {
    console.error(err);
    proxy.end();
});

process.on('SIGINT', () => {
    proxy.end();
});

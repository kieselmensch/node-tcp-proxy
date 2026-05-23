# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### Development
- **Install dependencies**: `npm install`
- **Lint code**: `npx eslint .`
- **Run proxy via CLI**: 
  ```bash
  node tcp-proxy-cli.js --proxyPort <port> --serviceHost <host> --servicePort <port>
  ```
- **Example with load balancing and TLS**:
  ```bash
  node tcp-proxy-cli.js --proxyPort 8080 --serviceHost host1,host2 --servicePort 80,80 --tls both
  ```

Note: This repository currently does not contain unit tests.

## Architecture and Structure

### High-Level Overview
`node-tcp-proxy` is a classical TCP proxy that forwards traffic from a local port to one or more remote service hosts. It supports TLS termination/initiation, round-robin load balancing, and basic authentication.

### Core Components
- **Library Entry (`index.js`)**: Exports the `createProxy` function for programmatic use.
- **Core Logic (`tcp-proxy.js`)**: Implements the `TcpProxy` class.
    - **Connection Handling**: Manages bidirectional data flow between clients and services using Node.js `net` and `tls` modules.
    - **Load Balancing**: Implements round-robin selection of service hosts when multiple targets are provided.
    - **Authentication**: Supports RFC 1413 (identd) authentication and IP address whitelisting.
    - **Interception**: Provides hooks (`upstream`, `downstream`) to modify data packets in transit and a hook (`serviceHostSelected`) to override the load balancing strategy.
- **CLI Wrapper (`tcp-proxy-cli.js`)**: A command-line interface built with `commander` that allows running the proxy as a standalone process.

### Data Flow
1. Client connects to `TcpProxy` listener (TCP or TLS).
2. Optional authentication check (IP whitelist $\rightarrow$ Identd).
3. `TcpProxy` selects a target service host via round-robin (or custom strategy).
4. A connection is established to the service (TCP or TLS).
5. Data is piped bidirectionally, passing through optional interceptors.

/**
 * auth-proxy
 *
 * Copyright (c) 2021 Doug Owings
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * @author Doug Owings <doug@dougowings.net>
 */
const fs        = require('fs').promises
const http      = require('http')
const httpProxy = require('http-proxy')
const merge     = require('merge')
const path      = require('path')
const YAML      = require('yaml')

const {resolve} = path

function log(...args) {
    console.log(new Date, ...args)
}

function error(...args) {
    console.error(new Date, ...args)
}

class App {

    static defaults(env) {
        env = env || process.env
        const configDir = resolve(env.CONFIG_DIR || 'local/config')
        if ('RELOAD_INTERVAL_MS' in env) {
            var reloadIntervalMs = +env.RELOAD_INTERVAL_MS || 0
        } else {
            var reloadIntervalMs = 15000
        }
        const headersStr = env.AUTH_HEADERS || 'x-authorization'
        
        return {
            configDir,
            reloadIntervalMs,
            port        : +env.HTTP_PORT || 8080,
            authHeaders : headersStr.split(',').map(it => it.trim().toLowerCase()),
            quiet       : false
        }
    }

    log(...args) {
        if (!this.opts.quiet) {
            log(...args)
        }
    }

    error(...args) {
        error(...args)
    }

    constructor(opts, env) {

        env = env || process.env

        this.opts = merge({}, App.defaults(env), opts)
        
        this.opts.tokensFile = this.opts.tokensFile || resolve(this.opts.configDir, env.TOKENS_FILE || 'tokens.yaml')
        this.opts.usersFile  = this.opts.usersFile  || resolve(this.opts.configDir, env.USERS_FILE  || 'users.yaml')
        this.opts.routesFile = this.opts.routesFile || resolve(this.opts.configDir, env.ROUTES_FILE || 'routes.yaml')
        this.opts.rolesFile  = this.opts.rolesFile  || resolve(this.opts.configDir, env.ROLES_FILE  || 'roles.yaml')

        this.tokens = null
        this.users  = null
        this.routes = null
        this.roles  = null

        this.tokenIndex = null
        this.roleIndex = null
        this.userIndex = null
        this.grantIndex = null

        this.lastReloadTime  = null
        this.lastReloadMTime = null
        this.reloadInterval  = null
        this.isReloading     = false

        this.httpServer = http.createServer((req, res) => {
            try {
                this.serve(req, res)
            } catch (err) {
                this.error(err)
                try {
                    res.writeHead(500).end('500 Internal Error')
                } catch (err) {
                    this.error(err)
                }
            }
        })

        this.httpProxy = httpProxy.createProxyServer()
    }

    serve(req, res) {

        const routeInfo = this.getRoute(req.method, req.url)
        
        if (!routeInfo) {
            res.writeHead(404).end('404 Not Found')
            return
        }
        const {route, matches} = routeInfo

        if (route.anonymous) {
            var user = 'anonymous'
        } else {
            // authenticate user
            var user = this.authenticate(req)
            if (!user) {
                res.writeHead(401).end('401 Unauthorized')
                return
            }
            // authorize
            const auth = this.authorize(user, route.resource, req.method)
            if (!auth) {
                res.writeHead(403).end('403 Forbidden')
                return
            }
        }

        this.log({user}, [req.method, route.resource])

        this.httpProxy.web(req, res, {target: route.proxy.target})
    }

    async start() {
        await this.reloadConfig()
        if (this.opts.reloadIntervalMs > 0) {
            this.reloadInterval = setInterval(() => {
                if (!this.isReloading) {
                    this.reloadConfig()
                }
            }, Math.max(this.opts.reloadIntervalMs, 1000))
        }
        this.httpServer.listen(this.opts.port)
        this.log('Listening', this.httpServer.address())
    }

    close() {
        clearInterval(this.reloadInterval)
        if (this.httpServer) {
            this.httpServer.close()
        }
    }

    authenticate(req) {
        for (var headerName of this.opts.authHeaders) {
            if (headerName in req.headers) {
                if (req.headers[headerName]) {
                    return this.tokenIndex[req.headers[headerName]]
                } else {
                    return
                }
            }
        }
    }

    authorize(user, resource, method) {
        if (!this.grantIndex[user]) {
            return false
        }
        if (!this.grantIndex[user][resource]) {
            return false
        }
        if (this.grantIndex[user][resource]['*']) {
            return true
        }
        return !!this.grantIndex[user][resource][method]
    }

    getRoute(method, path) {
        
        for (var route of this.routes) {
            var isMethodMatch = !route.methods || route.methods.indexOf(method) > -1
            //log({method}, route)
            if (!isMethodMatch) {
                continue
            }
            var matches = path.match(new RegExp(route.path))
            if (matches) {
                return {route, matches}
            }
        }
    }

    validateRoute(route) {
        if (typeof route.path != 'string' || !route.path.length) {
            throw new ConfigError('route.path must be a non-empty string')
        }
        if (typeof route.proxy != 'object' || Array.isArray(route.proxy)) {
            throw new ConfigError('route.proxy must be an object')
        }
        if (typeof route.proxy.target != 'string' || !route.proxy.target.length) {
            throw new ConfigError('route.proxy.target must be a non-empty string')
        }
    }

    validateToken(token) {
        if (typeof token.token != 'string' || !token.token.length) {
            throw new ConfigError('token.token must be a non-empty string')
        }
        if (typeof token.user != 'string' || !token.user.length) {
            throw new ConfigError('token.user must be a non-empty string')
        }
    }

    validateUser(user) {
        if (typeof user.name != 'string' || !user.name.length) {
            throw new ConfigError('user.name must be a non-empty string')
        }
        if (!Array.isArray(user.roles)) {
            throw new ConfigError('user.roles must be an array')
        }
        for (var roleName of user.roles) {
            if (typeof roleName != 'string' || !roleName.length) {
                throw new ConfigError('user role name must be a non-empty string')
            }
        }
    }

    validateRole(role) {
        if (typeof role.name != 'string' || !role.name.length) {
            throw new ConfigError('role.name must be a non-empty string')
        }
        if (typeof role.grants != 'object' || !Array.isArray(role.grants)) {
            throw new ConfigError('role.grants must be an array')
        }
        for (var grant of role.grants) {
            if (typeof grant.resource != 'string' || !grant.resource.length) {
                throw new ConfigError('grant.resource must be a non-empty string')
            }
            if (grant.methods) {
                if (typeof grant.methods != 'object' || !Array.isArray(grant.methods)) {
                    throw new ConfigError('grant.methods must be an array')
                }
            }
        }
    }

    async reloadConfig() {

        this.isReloading = true

        const routesHandle = await fs.open(this.opts.routesFile)
        const usersHandle  = await fs.open(this.opts.usersFile)
        const rolesHandle  = await fs.open(this.opts.rolesFile)
        const tokensHandle = await fs.open(this.opts.tokensFile)

        try {

            const maxMTime = Math.max(...[
                (await routesHandle.stat()).mtimeMs,
                (await usersHandle.stat()).mtimeMs,
                (await rolesHandle.stat()).mtimeMs,
                (await tokensHandle.stat()).mtimeMs
            ])

            if (this.lastReloadMTime && this.lastReloadMTime == maxMTime) {
                return
            }

            this.log({lastReloadMTime: this.lastReloadMTime, maxMTime})

            this.lastReloadMTime = maxMTime

            const routesObj = YAML.parse(await routesHandle.readFile('utf-8'))
            if (!routesObj.routes || !Array.isArray(routesObj.routes)) {
                throw new ConfigError('missing key routes or not array')
            }
            routesObj.routes.forEach(route => this.validateRoute(route))

            const usersObj = YAML.parse(await usersHandle.readFile('utf-8'))
            if (!usersObj.users || !Array.isArray(usersObj.users)) {
                throw new ConfigError('missing key users or not array')
            }
            usersObj.users.forEach(user => this.validateUser(user))
            const userIndex = this.getUserIndex(usersObj.users)

            const rolesObj = YAML.parse(await rolesHandle.readFile('utf-8'))
            if (!rolesObj.roles || !Array.isArray(rolesObj.roles)) {
                throw new ConfigError('missing key roles or not array')
            }
            rolesObj.roles.forEach(role => this.validateRole(role))
            const roleIndex = this.getRoleIndex(rolesObj.roles)

            const tokensObj = YAML.parse(await tokensHandle.readFile('utf-8'))
            if (!tokensObj.tokens || !Array.isArray(tokensObj.tokens)) {
                throw new ConfigError('missing key tokens or not array')
            }
            tokensObj.tokens.forEach(token => this.validateToken(token))
            const tokenIndex = this.getTokenIndex(tokensObj.tokens)

            const grantIndex = this.getGrantIndex(userIndex, roleIndex)

            this.routes = routesObj.routes
            this.users  = usersObj.users
            this.roles  = rolesObj.roles
            this.tokens = tokensObj.tokens

            this.tokenIndex = tokenIndex
            this.roleIndex = roleIndex
            this.userIndex = userIndex
            this.grantIndex = grantIndex

            this.log('Config reloaded', {
                routes : this.routes.length,
                roles  : this.roles.length,
                users  : this.users.length,
                tokens : this.tokens.length
            })

        } catch (err) {

            this.lastReloadErrorTime = +new Date

            if (!this.lastReloadTime) {
                throw err
            }

            error(err)

        } finally {

            routesHandle.close()
            usersHandle.close()
            rolesHandle.close()
            tokensHandle.close()

            this.isReloading = false
            this.lastReloadTime = +new Date
            this.lastReloadErrorTime = null
        }
    }

    // {token: userName}
    getTokenIndex(tokens) {
        const index = {}
        for (var token of tokens) {
            if (token.token in index) {
                throw new ConfigError('Duplicate token found for user ' + token.user)
            }
            index[token.token] = token.user
        }
        return index
    }

    // {roleName: roleObj}
    getRoleIndex(roles) {
        const index = {}
        for (var role of roles) {
            if (role.name in index) {
                throw new ConfigError('Duplicate role name found for ' + role.name)
            }
            index[role.name] = role
        }
        return index
    }

    // {userName: userObj}
    getUserIndex(users) {
        const index = {}
        for (var user of users) {
            if (user.name in index) {
                throw new ConfigError('Duplicate user name found for ' + user.name)
            }
            index[user.name] = user
        }
        return index
    }

    // {userName: {resource: {method: true}}}
    getGrantIndex(userIndex, roleIndex) {
        const index = {}
        for (var [userName, user] of Object.entries(userIndex)) {
            index[userName] = {}
            for (var roleName of user.roles) {
                var role = roleIndex[roleName]
                if (role) {
                    for (var grant of role.grants) {
                        if (!index[userName][grant.resource]) {
                            index[userName][grant.resource] = {}
                        }
                        if (grant.methods) {
                            for (var method of grant.methods) {
                                index[userName][grant.resource][method] = true
                            }
                        } else {
                            index[userName][grant.resource]['*'] = true
                        }
                    }
                }
            }
        }
        return index
    }
}

class BaseError extends Error {
    constructor(...args) {
        super(...args)
        this.name = this.constructor.name
    }
}

class ConfigError extends BaseError {}

module.exports = App
const fs    = require('fs').promises
const http  = require('http')
const httpProxy = require('http-proxy')
const merge = require('merge')
const path  = require('path')
const YAML  = require('yaml')

const {resolve} = path

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
            tokensFile  : resolve(configDir, env.TOKENS_FILE || 'tokens.yaml'),
            usersFile   : resolve(configDir, env.USERS_FILE  || 'users.yaml'),
            routesFile  : resolve(configDir, env.ROUTES_FILE || 'routes.yaml'),
            rolesFile   : resolve(configDir, env.ROLES_FILE  || 'roles.yaml'),
            authHeaders : headersStr.split(',').map(it => it.trim().toLowerCase())
        }
    }

    constructor(opts, env) {
        this.opts = merge({}, App.defaults(env), opts)
        this.tokens = null
        this.users  = null
        this.routes = null
        this.roles  = null

        this.tokenIndex = null
        this.roleIndex = null
        this.userIndex = null

        this.lastReloadTime = null
        this.lastReloadMTime = null
        this.reloadInterval = null
        this.isReloading = false
        this.httpServer = http.createServer((req, res) => {
            this.serve(req, res)
        })
        this.httpProxy = httpProxy.createProxyServer()
    }

    serve(req, res) {

        const {route, matches} = this.getRoute(req.method, req.url)
        if (!route) {
            res.writeHead(404).end('404 Not Found')
            return
        }

        console.log({route, headers: req.headers})

        if (!route.anonymous) {
            // authenticate user
            const user = this.authenticate(req)
            if (!user) {
                res.writeHead(401).end('401 Unauthorized')
                return
            }
            // authorize
            const auth = this.authorize(user, route.resource, req.method)
        }

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
        if (!this.userIndex[user]) {
            return false
        }
        for (var roleName of this.userIndex[user].roles) {
            if (roleName in this.roleIndex) {
                var role = this.roleIndex[roleName]
                for (var grant of role.grants) {
                    if (grant.resource == resource) {
                        if (!grant.methods || grant.methods.indexOf(method) > -1) {
                            return true
                        }
                    }
                }
            }
        }
        return false
    }

    getRoute(method, path) {
        for (var route of this.routes) {
            var isMethodMatch = !route.methods || route.methods.indexOf(method) > -1
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

            // TODO: check async handle.stat()  .mtimeMs
            const mtimes = [
                (await routesHandle.stat()).mtimeMs,
                (await usersHandle.stat()).mtimeMs,
                (await rolesHandle.stat()).mtimeMs,
                (await tokensHandle.stat()).mtimeMs
            ]

            const maxMTime = Math.max(...mtimes)

            if (this.lastReloadMTime && this.lastReloadMTime == maxMTime) {
                return
            }

            console.log({lastReloadMTime: this.lastReloadMTime, maxMTime})

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

            this.routes = routesObj.routes
            this.users  = usersObj.users
            this.roles  = rolesObj.roles
            this.tokens = tokensObj.tokens
            this.tokenIndex = tokenIndex
            this.roleIndex = roleIndex
            this.userIndex = userIndex

            console.log('Config reloaded')

        } catch (err) {

            this.lastReloadErrorTime = +new Date

            if (!this.lastReloadTime) {
                throw err
            }

            console.error(err)

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
}

class BaseError extends Error {
    constructor(...args) {
        super(...args)
        this.name = this.constructor.name
    }
}

class ConfigError extends BaseError {}

module.exports = App
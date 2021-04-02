const {expect} = require('chai')
const fetch = require('node-fetch')
const fs = require('fs')
const fse = require('fs-extra')
const http = require('http')
const merge = require('merge')
const path = require('path')
const {resolve} = path
const tmp = require('tmp')
const YAML = require('yaml')

const App = require('../src/app')

const appUrl = 'http://localhost:' + (+process.env.HTTP_PORT || 8080)

const upstreamServer = http.createServer((req, res) => {
    res.writeHead(200)
    res.end('OK')
})

var upstreamPort
beforeEach(() => {
    upstreamServer.listen()
    upstreamPort = upstreamServer.address().port
    //console.log({upstreamPort})
})

afterEach(() => {
    upstreamServer.close()
})

function newApp(configName, opts, env) {
    configName = configName || '01'
    opts = merge({}, {quiet: true, configDir: resolve(__dirname, 'configs', configName)}, opts)
    const app = new App(opts, env)
    //console.log(app.opts)
    return app
}

function hackRoutes(app) {
    // hack routes
    for (var route of app.routes) {
        route.proxy.target = 'http://localhost:' + upstreamPort
    }
}

function getError(cb) {
    try {
        cb()
    } catch (err) {
        return err
    }
}

describe('proxy', () => {

    describe('01', () => {

        var app

        beforeEach(async () => {
            app = newApp('01')
            await app.start()
            hackRoutes(app)
        })

        afterEach(() => {
            app.close()
        })

        it('should GET /public with no token', async () => {
            const res = await fetch(appUrl + '/public', {
                method: 'GET'
            })
            expect(res.status).to.equal(200)
        })

        it('should GET /public with any token', async () => {
            const res = await fetch(appUrl + '/public', {
                method: 'GET',
                headers: {'x-authorization': 'abc'}
            })
            expect(res.status).to.equal(200)
        })

        it('john should GET / with correct token', async () => {
            const res = await fetch(appUrl, {
                method: 'GET',
                headers: {'x-authorization': 'yhmYJA8JhX75bD877fQvBcDWBA3PXRCg'}
            })
            expect(res.status).to.equal(200)
        })

        it('should return 401 for GET / with no token', async () => {
            const res = await fetch(appUrl, {
                method: 'GET'
            })
            expect(res.status).to.equal(401)
        })

        it('should return 401 for GET / with empty token', async () => {
            const res = await fetch(appUrl, {
                method: 'GET',
                headers: {'x-authorization': ''}
            })
            expect(res.status).to.equal(401)
        })

        it('should return 401 for GET / with incorrect token', async () => {
            const res = await fetch(appUrl, {
                method: 'GET',
                headers: {'x-authorization': 'sadfkjlhasdkljhlaskjdhklasjdasdd'}
            })
            expect(res.status).to.equal(401)
        })

        it('should return 404 for HEAD / with no token', async () => {
            const res = await fetch(appUrl, {
                method: 'HEAD'
            })
            expect(res.status).to.equal(404)
        })

        it('no-role bob should have 403 for GET / with correct token', async () => {
            const res = await fetch(appUrl, {
                method: 'GET',
                headers: {'x-authorization': 'nEmzFSdB7ujfczSSrwKYMXjajUwux5FX'}
            })
            expect(res.status).to.equal(403)
        })

        it('george should get 403 for GET / with correct token', async () => {
            const res = await fetch(appUrl, {
                method: 'GET',
                headers: {'x-authorization': 'UYYw2Sa8DHPL56xh5WJJ4jccPp7YDwSZ'}
            })
            expect(res.status).to.equal(403)
        })

        it('george should get 200 for GET /george with correct token', async () => {
            const res = await fetch(appUrl + '/george', {
                method: 'GET',
                headers: {'x-authorization': 'UYYw2Sa8DHPL56xh5WJJ4jccPp7YDwSZ'}
            })
            expect(res.status).to.equal(200)
        })

        it('john should have 403 for PUT / with correct token', async () => {
            const res = await fetch(appUrl, {
                method: 'PUT',
                headers: {'x-authorization': 'yhmYJA8JhX75bD877fQvBcDWBA3PXRCg'}
            })
            expect(res.status).to.equal(403)
        })

        it('alice should have 200 for PUT / with correct token', async () => {
            const res = await fetch(appUrl, {
                method: 'PUT',
                headers: {'x-authorization': 'B73XLv8QuygG5f629Ja4rYJfEBnyNzVY'}
            })
            expect(res.status).to.equal(200)
        })

        it('should return 200 for GET /hostroute for host1.example', async () => {
            const res = await fetch(appUrl + '/hostroute', {
                headers: {host: 'host1.example'}
            })
            expect(res.status).to.equal(200)
        })

        it('should return 200 for GET /hostroute for host2.example', async () => {
            const res = await fetch(appUrl + '/hostroute', {
                headers: {host: 'host2.example'}
            })
            expect(res.status).to.equal(200)
        })

        it('should return 401 for GET /hostroute with no host set', async () => {
            const res = await fetch(appUrl + '/hostroute')
            expect(res.status).to.equal(401)
        })
    })
})

describe('app', () => {

    var app

    beforeEach(() => {
        app = newApp()
    })

    describe('#getTokenIndex', () => {

        it('should fail on duplicate token', () => {
            const err = getError(() => {
                app.getTokenIndex([
                    {token: 'abc', user: 'john'},
                    {token: 'abc', user: 'bill'}
                ])
            })
            expect(err.name).to.equal('ConfigError')
        })
    })

    describe('#getRoleIndex', () => {

        it('should fail on duplicate name', () => {
            const err = getError(() => {
                app.getRoleIndex([
                    {name: 'abc', grants: []},
                    {name: 'abc', grants: []}
                ])
            })
            expect(err.name).to.equal('ConfigError')
        })
    })

    describe('#getUserIndex', () => {

        it('should fail on duplicate name', () => {
            const err = getError(() => {
                app.getUserIndex([
                    {name: 'abc', roles: []},
                    {name: 'abc', roles: []}
                ])
            })
            expect(err.name).to.equal('ConfigError')
        })
    })

    describe('#validateRoute', () => {

        it('should throw on missing path', () => {
            const err = getError(() => app.validateRoute({}))
            expect(err.name).to.equal('ConfigError')
        })

        it('should throw for invalid path regex', () => {
            const err = getError(() => app.validateRoute({
                path: 'sadf(.*',
                proxy: {target: 'foo.example'},
                resource: 'api'
            }))
            expect(err.name).to.equal('ConfigError')
        })

        it('should throw on missing proxy', () => {
            const err = getError(() => app.validateRoute({path: '/'}))
            expect(err.name).to.equal('ConfigError')
        })

        it('should throw on proxy is array', () => {
            const err = getError(() => app.validateRoute({path: '/', proxy: []}))
            expect(err.name).to.equal('ConfigError')
        })

        it('should throw on missing proxy target', () => {
            const err = getError(() => app.validateRoute({path: '/', proxy: {}}))
            expect(err.name).to.equal('ConfigError')
        })

        it('should throw on null hosts', () => {
            const err = getError(() => app.validateRoute({
                path: '/',
                proxy: {target: 'foo.example'},
                resource: 'api',
                hosts: null
            }))
            expect(err.name).to.equal('ConfigError')
        })

        it('should throw for invalid host', () => {
            const err = getError(() => app.validateRoute({
                path: '/',
                proxy: {target: 'foo.example'},
                resource: 'api',
                hosts: [1]
            }))
            expect(err.name).to.equal('ConfigError')
        })

        it('should throw for invalid host regex', () => {
            const err = getError(() => app.validateRoute({
                path: '/',
                proxy: {target: 'foo.example'},
                resource: 'api',
                hosts: ['asdf(.*']
            }))
            expect(err.name).to.equal('ConfigError')
        })
    })

    describe('#validateToken', () => {

        it('should throw on missing token', () => {
            const err = getError(() => app.validateToken({}))
            expect(err.name).to.equal('ConfigError')
        })

        it('should throw on missing user', () => {
            const err = getError(() => app.validateToken({token: 'abc'}))
            expect(err.name).to.equal('ConfigError')
        })
    })

    describe('#validateUser', () => {

        it('should throw on missing name', () => {
            const err = getError(() => app.validateUser({}))
            expect(err.name).to.equal('ConfigError')
        })

        //it('should throw on missing roles', () => {
        //    const err = getError(() => app.validateUser({name: 'john'}))
        //    expect(err.name).to.equal('ConfigError')
        //})

        it('should throw on missing role name', () => {
            const err = getError(() => app.validateUser({name: 'john', roles:[{}]}))
            expect(err.name).to.equal('ConfigError')
        })
    })

    describe('#validateRole', () => {

        it('should throw on missing name', () => {
            const err = getError(() => app.validateRole({}))
            expect(err.name).to.equal('ConfigError')
        })

        it('should throw on missing grants', () => {
            const err = getError(() => app.validateRole({name: 'role'}))
            expect(err.name).to.equal('ConfigError')
        })

        it('should throw on missing grant resource', () => {
            const err = getError(() => app.validateRole({name: 'role', grants: [{}]}))
            expect(err.name).to.equal('ConfigError')
        })

        it('should throw on grant methods string', () => {
            const err = getError(() => app.validateRole({name: 'role', grants: [{resource: 'app', methods: 'str'}]}))
            expect(err.name).to.equal('ConfigError')
        })

        it('should pass on missing grant methods', () => {
            app.validateRole({name: 'role', grants: [{resource: 'app'}]})
        })
    })
})

describe('reload', () => {
    it('should reload in 1 second and get new token', async function() {
        this.timeout(3000)
        const configDir = tmp.dirSync().name
        try {
            await fse.copy(resolve(__dirname, 'configs/01'), configDir)
            const app = new App({
                quiet: true,
                configDir,
                reloadIntervalMs: 1000
            })
            await app.start()
            try {
                const tokensFile = resolve(configDir, 'tokens.yaml')
                const tokens = YAML.parse(fs.readFileSync(tokensFile, 'utf-8'))
                tokens.tokens.push({user: 'jeff', token: 'm8nzwT8LKwNm733NRuLuBgU77sbK3hEb'})
                fs.writeFileSync(tokensFile, YAML.stringify(tokens))
                await new Promise(resolve => setTimeout(resolve, 1100))
                expect(app.tokenIndex['m8nzwT8LKwNm733NRuLuBgU77sbK3hEb']).to.equal('jeff')
            } finally {
                app.close()
            }
        } finally {
            fse.remove(configDir)
        }
       
    })
})
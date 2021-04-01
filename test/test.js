const {expect} = require('chai')
const http = require('http')

const upstreamServer = http.createServer((req, res) => {
    res.writeHead(200)
    res.end('OK')
})

var upstreamPort
beforeEach(() => {
    upstreamServer.listen()
    upstreamPort = upstreamServer.address().port
    console.log({upstreamPort})
})

afterEach(() => {
    upstreamServer.close()
})

describe('upsteam', () => {
    it('upstream should listen', () => {
        
    })
})

describe('proxy', () => {
    
})
const port = +process.argv[2] || 8081
require('http').createServer((req, res) => {
    res.writeHead(200)
    console.log({
        url: req.url,
        method: req.method
    })
    res.end('Upstream OK')
}).listen(port)
console.log({port})

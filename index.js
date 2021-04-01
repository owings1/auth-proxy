const App = require('./src/app')
const app = new App()

process.on('SIGINT', () => {
    console.log('SIGINT: Shutting down')
    try {
        app.close()
    } catch (e) {
        console.error(e)
    }
})

app.start()
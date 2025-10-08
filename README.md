## Quickstart

### Backend
Install Node.js.
1. Mac: Install [Homebrew](https://brew.sh/) and execute `brew install node`
2. Run `npm install`
3. Run `npm run dev`
4. Visit [http://localhost:3000](http://localhost:3000)

### Front End
1. Open a new terminal and navigate to the `frontend` directory: `cd frontend`
2. Run `npm install`
3. Run `npm run dev`
4. Visit [http://localhost:8080](http://localhost:8080)


## Docker

```sh
docker build -t jspsi-gui .
docker run -d --rm -p 8080:8080 -p 3000:3000 --name jspsi-gui jspsi-gui
```

Visit [http://localhost:8080](http://localhost:8080)

When done:

```sh
docker stop jspsi-gui
```

To permanently clean up:

```sh
docker image rm jspsi-gui
```

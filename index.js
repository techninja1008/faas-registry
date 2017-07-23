const config = require("./config.json")

const Minio = require ("minio")
const fs = require("fs")
const MultiTennantGateway = require("./gateway")

try{
  fs.mkdirSync(config.data_location)
}catch(e){}

function createIfNotExists(client, bucket){
  return new Promise((resolve, reject) => {
    client.bucketExists(bucket, function(err) {
      if (err) {
        if (err.code == 'NoSuchBucket') {
          minioClient.makeBucket(bucket, config.bucket.region, function(errt) {
            if (errt) return reject(errt)
            resolve(1)
          })
        }
        reject(err)
        return
      }
      resolve(0)
    })
  })
}

let minioClient = new Minio.Client(config.minio)

global.MC = minioClient;

createIfNotExists(minioClient, config.bucket.name).then(res => {
  let gw = new MultiTennantGateway({});
  gw.listen(process.env.PORT)
}).catch(err => {
  console.log(err)
})
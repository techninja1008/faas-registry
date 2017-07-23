const Gateway = require("faaslang").Gateway;
const url = require("url");
const fs = require("fs");
const config = require("./config.json");
const rimraf = require("rimraf");
const mkdirp = require("mkdirp");
const targz = require('targz');
const FunctionParser = require('faaslang').FunctionParser;
const path = require('path');

class MultiTennantGateway extends Gateway {

  constructor(cfg) {
    cfg = cfg || {};
    cfg.name = 'MultiTennantGateway';
    super(cfg);
  }

  formatName(name) {
    return `${this.name}`
  }

  formatRequest(req) {
    return `(${req ? (req._background ? 'bg:' : '') + req._uuid.split('-')[0] : 'GLOBAL'}) ${this.routename(req)}`
  }

  formatMessage(message, logType) {
    return super.formatMessage(message, logType);
  }

  environment(env) {
    Object.keys(env).forEach(key => process.env[key] = env[key]);
    return true;
  }

  createContext(req, definitions, params, data) {
    let context = super.createContext(req, definitions, params, data);
    //context.service = {};
    //context.service.name = this.serviceName;
    //context.service.path = this.serviceName.split('/');
    //context.service.version = null;
    //context.service.environment = 'local';
    //context.service.identifier = `${context.service.path.join('.')}[@${context.service.version || context.service.environment}]`;
    return context;
  }

  resolve(req, res, buffer, callback) {
    let self = this;
    
    let urlinfo = url.parse(req.url, true);
    let pathname = urlinfo.pathname;
    let segments = pathname.match(/^\/(.*[^\/])\/?$/)[1].split("/");
    console.log(segments)
    if(segments.length < 2){
      return callback({statusCode: 404})
    }
    
    
    let ns = segments[0];
    let match = segments[1].match(/^([A-Za-z][A-Za-z0-9_]*)@([0-9]|[0-9][0-9]|[0-9][0-9\.]+[0-9])$/);
    let service = match[1];
    let version = match[2];
    
    function parseDefinitions(){
      let folder = config.data_location + "/" + ns + "/" + service + "/" + version + "/data/";
      
      let fp = new FunctionParser();
      let definitions = fp.load(folder, "functions");
      
      segments.shift(); segments.shift();
      
      let definition;
      try {
        definition = self.findDefinition(definitions, "/" + segments.join("/"));
      } catch (e) {
        e.statusCode = 404;
        return callback(e);
      }
      
      definition.mtroot = config.data_location + "/" + ns + "/" + service + "/" + version + "/data/"
      
      return callback(null, definition, {}, buffer);
    }
    
    MC.statObject(config.bucket.name, ns + "/" + service + "/" + version + ".tgz", function(err, stat) {
      if (err) {
        return callback(err);
      }
      let dateModified = Date.parse(stat.lastModified);
      
      if(!fs.existsSync(config.data_location + "/" + ns + "/" + service + "/" + version + "/dateModified") || parseInt(fs.readFileSync(config.data_location + "/" + ns + "/" + service + "/" + version + "/dateModified")) < dateModified){
        if(fs.existsSync(config.data_location + "/" + ns + "/" + service + "/" + version + "/")){
          rimraf.sync(config.data_location + "/" + ns + "/" + service + "/" + version + "/")
        }
        mkdirp.sync(config.data_location + "/" + ns + "/" + service + "/" + version + "/")
        
        fs.writeFileSync(config.data_location + "/" + ns + "/" + service + "/" + version + "/dateModified", dateModified)
        
        MC.fGetObject(config.bucket.name, ns + "/" + service + "/" + version + ".tgz", config.data_location + "/" + ns + "/" + service + "/" + version + "/bundle.tgz", function(errt) {
          if (errt) {
            return callback(errt);
          }
          targz.decompress({
            src: config.data_location + "/" + ns + "/" + service + "/" + version + "/bundle.tgz",
            dest: config.data_location + "/" + ns + "/" + service + "/" + version + "/data/"
          }, function(errtt){
            if(errtt) {
              return callback(errtt);
            } else {
              parseDefinitions();
            }
          });
        })
        return
      }
      
      parseDefinitions();
    })
  }

  end(req, value) {
    this.log(req, value, 'result');
  }
  
  execute(definition, functionArgs, data, callback) {
    let fn;
    try {
      let rpath = require.resolve(path.join(definition.mtroot, definition.pathname));
      delete require[rpath];
      fn = require(rpath);
    } catch (e) {
      e.fatal = true;
      return callback(e);
    }
    if (definition.format.async) {
      fn.apply(null, functionArgs)
        .then(result => callback(null, result))
        .catch(err => callback(err));
    } else {
      fn.apply(null, functionArgs.concat(callback));
    }
  }

}

module.exports = MultiTennantGateway;
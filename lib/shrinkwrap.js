var npm = require('npm');
var q = require('q');
var npmFlatten = require('./npmFlatten');
var npmLoad = q.nbind(npm.load, npm);
var _ = require('lodash')
var http = require('https');
var url = require('url');

var cache = {};
var githubCache = {};


// lame test whether a version constraint is a git url
var isGitUrl = function(constraint) {
  return /\//.test(constraint);
};


var fetchJsonFile = function(fileUrl) {
  var deferred = q.defer();
  var buffer = '';

  http.get(fileUrl,function(resp) {
    resp.on('data', function(data) {
      buffer += data.toString();
    });
    resp.on('end', function() {
      // try {
      //   if (!buffer) {
      //     return deferred.reject('No response')
      //   }
        deferred.resolve(JSON.parse(buffer));
      // } catch (e) {
      //   console.log('ERROR\n', fileUrl, buffer)
      //   throw e;
      // }
    });
  }).on('error', function(err) {
    deferred.reject(err);
  });

  return deferred.promise;
};


var parseGitUrl = function(gitUrl) {
  var parsed = url.parse(gitUrl);
  var repo = parsed.path.replace(/^\//, '').replace(/\.git$/, '');
  var branch = parsed.hash ? parsed.hash.replace(/^\#/, '') : 'master';

  return {
    repo: repo,
    branch: branch,
    shortUrl: repo + '#' + branch,
    url: 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/package.json'
  };
};


var fetchPackageFromGithub = function(version) {
  var pkgInfo = parseGitUrl(version);

  if (!githubCache[pkgInfo.url]) {
    console.log('github fetch ', pkgInfo.url)
    githubCache[pkgInfo.url] = fetchJsonFile(pkgInfo.url).then(null, function() {
      return {version: 'unknown'};
    });
  }

  return githubCache[pkgInfo.url];
};


// Lame and hacky. We resolve all git urls into version,
// by fetching package.json from github.
var resolveGitUrls = function(dependencies) {
  var pending = [];
  var normalized = {};

  _.each(dependencies, function(constraint, name) {
    if (isGitUrl(constraint)) {
      pending.push(fetchPackageFromGithub(constraint).then(function(packageFromGithub) {
        console.log('resolved', name, constraint, '->', packageFromGithub.version);
        normalized[name] = packageFromGithub.version;
      }))
    } else {
      normalized[name] = constraint;
    }
  });

  return q.all(pending).then(function() {
    return normalized;
  });
};


var createFlatShrinkwrap = function(name, version, flatDeps) {
  // Generate shrinkwrap.
  var shrinkwrap = {
    name: name,
    version: version,
    dependencies: {}
  };

  _.each(flatDeps, function(_, name) {
    var cached = cache[name].inspect().value;

    if (cached.isGitUrl) {
      shrinkwrap.dependencies[name] = {
        version: flatDeps[name],
        from: 'git://github.com/' + cached.from,
        dependencies: {}
      };
    } else {
      shrinkwrap.dependencies[name] = {
        version: flatDeps[name],
        from: name + '@' + flatDeps[name],
        dependencies: {}
      };
    }
  });

  return shrinkwrap;
};


// Init NPM, returns a registry.
var initializeNpm = function() {
  return npmLoad().then(function() {
    var registryGet = q.nbind(npm.registry.get, npm.registry);

    return {
      get: function (name) {
        // console.log('get', name)
        if (!cache[name]) {
          cache[name] = registryGet(name).then(function(data) {
            var multiVersionPkg = data[0];
            var penging = [];

            // Go through all versions and resolve the git url dependencies...
            _.each(multiVersionPkg.versions, function(pkg, version) {
              penging.push(resolveGitUrls(pkg.dependencies).then(function(resolvedDeps) {
                pkg.dependencies = resolvedDeps;
              }));
            })

            return q.all(penging).then(function() {
              return multiVersionPkg;
            });
          });
        }

        return cache[name];
      }
    };
  });
};


// Prefetch github repos, into the cache, returns none.
var prefetchGithubPackages = function(githubReposToLoad) {
  return q.all(githubReposToLoad.map(function(handle) {
    return fetchPackageFromGithub(handle).then(function(pkg) {
      return resolveGitUrls(pkg.dependencies).then(function(resolvedDeps) {
        var versions = {};
        versions[pkg.version] = pkg;
        pkg.dependencies = resolvedDeps;

        cache[pkg.name] = q({
          isGitUrl: true,
          from: parseGitUrl(handle).shortUrl,
          versions: versions
        });
      });
    });
  }));
};


module.exports = function(rootPackage, githubReposToLoad) {
  return q.all([
    initializeNpm(),
    resolveGitUrls(rootPackage.dependencies),
    prefetchGithubPackages(githubReposToLoad)
  ]).then(function(container) {
    var registry = container[0];
    var resolvedDeps = container[1];

    return npmFlatten.resolvePackages(registry, resolvedDeps).then(function (flatDeps) {
      return createFlatShrinkwrap(rootPackage.name, rootPackage.version, flatDeps);
    });
  });
};

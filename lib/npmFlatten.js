var _ = require("lodash");
var q = require('q');
var semver = require('semver');

function ConflictError(dependency, constraints) {
  this.dependency = dependency;
  this.constraints = constraints;
}

ConflictError.prototype.toString = function () {
  return 'None of "' + this.dependency + '" version satisfies all the constraints: (' + this.constraints.join(', ') + ')';
};

function getAllVersionsInRange(repository, name, constraint) {
  return repository.get(name).then(function (packageInfo) {
    if (constraint === 'latest') {
      return _.keys(packageInfo.versions).sort(semver.rcompare);
    }

    var validVersions = _.keys(packageInfo.versions).sort(semver.rcompare).filter(function (versionCandidate) {
      return semver.satisfies(versionCandidate, constraint);
    });


    if (!validVersions.length) {
      console.log('There is no valid version available for ' + name + '@' + constraint, ', only ' + _.keys(packageInfo.versions).sort(semver.rcompare).join(', ') + ' available.')
      throw new Error('There is no valid version available for ' + name + '@' + constraint, ', only ' + _.keys(packageInfo.versions).sort(semver.rcompare).join(', ') + ' available.');
    }

    return validVersions;
  });
}

function getPackageDependencies(repository, name, version) {
  return repository.get(name).then(function (packageInfo) {
    var versionInfo = packageInfo.versions[version];
    if (!versionInfo) {
      throw new Error('There is no package info for ' + name + '@' + version)
    }
    return versionInfo.dependencies || {};
  });
}

function getDependencyVersionsToSelect(repository, name, constraint, currentSolution, remainingToSelect) {

  //possible conflict: current solution
  if (currentSolution[name]) {
    if (!semver.satisfies(currentSolution[name], constraint)) {
      return q.reject(new ConflictError(name, [currentSolution[name], constraint])); //backtrack
    } else {
      return [currentSolution[name]];
    }
  } else {
    //possible conflict: remaining to select
    if (remainingToSelect[name]) {
      return getAllVersionsInRange(repository, name, constraint).then(function (allInRange) {
        var versionsIntersect = _.intersection(remainingToSelect[name], allInRange);
        //if an intersection is empty we can abort, as we are never going to find any matching version
        if (versionsIntersect.length === 0) {
          return q.reject(new ConflictError(name, [null, constraint])); //backtrack
        }
        return versionsIntersect;
      });
    } else {
      return getAllVersionsInRange(repository, name, constraint);
    }
  }
}

var nastyGlobalBestSolution = null;
var nastyGlobalBestSolutionWeight = 0;
var nastyGlobalBestSolutionName = null;
var nastyGlobalBestSolutionOtherName = null;
var lastProgress = Date.now();

function tryDependencyVersions(repository, name, versions, currentSolution, remainingToSelect, level) {
  // if (lastProgress + 10 < Date.now()) {
  //   console.log(currentSolution);
  //   lastProgress = Date.now();
  // }

  // console.log(remainingToSelect)

  var version = versions[0];
  return getPackageDependencies(repository, name, version).then(function (dependencies) {

    var newSolution = _.assign({}, currentSolution);
    newSolution[name] = version;
    // console.log('setting', name, version)

    console.log(level + 1, name);
    return resolvePackages(repository, dependencies, newSolution, remainingToSelect, level + 1).then(function (solution) {
      return solution;
    }, function (err) {
      if (false && versions.length > 1) {
        return tryDependencyVersions(repository, name, _.drop(versions), currentSolution, remainingToSelect, level + 1);
      } else {
        var weight = Object.keys(currentSolution).length;

        if (weight > nastyGlobalBestSolutionWeight) {
          nastyGlobalBestSolution = _.clone(currentSolution);
          nastyGlobalBestSolutionWeight = weight;
          nastyGlobalBestSolutionName = err.dependency;
          nastyGlobalBestSolutionOtherName = name;
        }

        // FAIL
        if (weight === 0) {
          console.log('FAIL');
          console.log('best solution', nastyGlobalBestSolution);

          _.each(nastyGlobalBestSolution, function(version, dependentName) {
            var deps = repository.get(dependentName).inspect().value.versions[nastyGlobalBestSolution[dependentName]].dependencies;
            if (deps && deps[nastyGlobalBestSolutionName]) {
              console.log(dependentName + '@' + version + ' wants ' + nastyGlobalBestSolutionName + '@' + deps[nastyGlobalBestSolutionName]);
            }
          });

          var otherNameVersions = {};
          var otherNamePkg = repository.get(nastyGlobalBestSolutionOtherName).inspect().value;
          _.each(otherNamePkg.versions, function(pkg, version) {
            if (pkg.dependencies && pkg.dependencies[nastyGlobalBestSolutionName]) {
              otherNameVersions[version] = pkg.dependencies[nastyGlobalBestSolutionName];
            }
          });

          console.log(nastyGlobalBestSolutionOtherName + ' wants', otherNameVersions)

          // var otherNameVersions = {};
          // var otherNamePkg = repository.get(nastyGlobalBestSolutionOtherName).inspect().value;
          _.each(nastyGlobalBestSolution, function(version, name) {
            _.each(repository.get(name).inspect().value.versions[version].dependencies, function(constraint, depName) {
              if (depName === nastyGlobalBestSolutionOtherName) {
                console.log('XXX', name)
              }
            });
          });
        }

        return q.reject(err);
      }
    });
  });
}


/**
 * Given a list of root (top-level) dependencies, traverse the whole dependency tree and try to flattenme, version  in.
 * There are multiple possible valid solutions and this function will return only one such solution or will
 * throw an exception if a solution doesn't exist.
 *
 * @param repository
 * @param rootDependencies an Object where keys are dependency names and values are semver ranges
 * @param currentSolution an Object representing solution built so far
 * @param remainingToSelect an Object representing a set of dependencies that are remaining to be selected
 * @returns {*}
 */
var possibleCutsAlreadyShown = Object.create(null);
function resolvePackages(repository, rootDependencies, currentSolution, remainingToSelect, level) {
  // _.each(remainingToSelect, function(versions, name) {
  //   if (versions.length > 1 && !possibleCutsAlreadyShown[name]) {
  //     console.log('possible cut:')
  //     console.log('"' + name + '": "' + versions[0] + '"', versions)
  //     possibleCutsAlreadyShown[name] = true;
  //   }
  // })

  if ((Date.now() - lastProgress) > 10000 ) {
    // console.log(nastyGlobalBestSolution)
    // console.log(remainingToSelect)
    // console.log('current best: ' + nastyGlobalBestSolutionWeight);
    // console.log('remaining: ' + Object.keys(remainingToSelect).length);
    // lastProgress = Date.now();
  }

  var remainingToSelectKeys = _.keys(rootDependencies);
  var newDepsPromises = remainingToSelectKeys.map(function (name) {
    return getDependencyVersionsToSelect(repository, name, rootDependencies[name], currentSolution, remainingToSelect);
  });

  return q.all(newDepsPromises).then(function (versionsToSelect) {

    var depsToSelect = _.assign({}, remainingToSelect);
    versionsToSelect.forEach(function (version, idx) {
      var name = remainingToSelectKeys[idx];
      if (!currentSolution[name]) {
        depsToSelect[remainingToSelectKeys[idx]] = version;
      }
    });

    //do I have a solution already?
    if (_.keys(depsToSelect).length) {
      // console.log('LEVEL', level, 'remain:', _.keys(depsToSelect).length);


      //forEach dependency
      return _.keys(depsToSelect).reduce(function (parentSolutionPromise, nextSelection) {

        var newRemainingToSelect = _.assign({}, depsToSelect);
        delete newRemainingToSelect[nextSelection];

        return parentSolutionPromise.then(function (parentSolution) {
          // TODO(vojta): check it is a valid version
          if (parentSolution[nextSelection]) {
            return parentSolution;
          }

          //forEach version
          return tryDependencyVersions(repository, nextSelection, depsToSelect[nextSelection], parentSolution, newRemainingToSelect, level);
        });

      }, q.when(currentSolution));
    } else {
      // console.log('LEVEL', level, 'SOLVED');
      return q.when(currentSolution);
    }
  });
}

exports.resolvePackages = function (repository, rootPackage) {
  return resolvePackages(repository, rootPackage, {}, {}, 0);
};

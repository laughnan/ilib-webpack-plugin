/**
 * ilib-webpack-plugin.js - A webpack plugin to process js files and include
 * all of the ilib locale data that is needed for the requested locales
 *
 * @license
 * Copyright © 2018, JEDLSoft
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var path = require('path');
var fs = require('fs');
var ilib;
var Locale;
var Utils;
var LocaleMatcher;
var PLUGIN_NAME = 'IlibDataPlugin';

var localeData = new Set();

function loadIlibClasses(location) {
    if (location) {
        ilib = require(path.join(location, "lib/ilib-node.js"));
        Locale = require(path.join(location, "lib/Locale.js"));
        Utils = require(path.join(location, "lib/Utils.js"));
        LocaleMatcher = require(path.join(location, "lib/LocaleMatcher.js"));
    } else {
        ilib = require("ilib");
        Locale = require('ilib/lib/Locale.js');
        Utils = require('ilib/lib/Utils.js');
        LocaleMatcher = require('ilib/lib/LocaleMatcher.js');
    }
}

function makeDirs(path) {
    var parts = path.split(/[\\\/]/);

    for (var i = 1; i <= parts.length; i++) {
        var p = parts.slice(0, i).join("/");
        if (p && p.length > 0 && !fs.existsSync(p)) {
            fs.mkdirSync(p);
        }
    }
}

function toIlibDataName(str) {
    return (!str || str === "root" || str === "*") ? "" : str.replace(/[\.:\(\)\/\\\+\-]/g, "_");
}

function findIlibRoot() {
    var dir = module.paths.find(function(p) {
        return fs.existsSync(path.join(p, "ilib/package.json"));
    });
    return dir && path.join(dir, "ilib");
}

/**
 * Convert a set to an array.
 *
 * @param {Set} set to convert
 * @returns an array with the contents of the set
 */
function toArray(set) {
    var ret = [];
    set.forEach(function(element) {
        ret.push(element);
    });
    return ret;
}

function calcDataRoot(options) {
    var ilibRoot = options.ilibRoot;
    if (!ilibRoot) {
        return path.join(findIlibRoot(), "locale");
    } else {
        return path.join(ilibRoot, (options.compilation && options.compilation === "uncompiled") ? "data/locale" : "locale");
    }
}

var normPattern = /(nfc|nfd|nfkc|nfkd)(\/(\w+))?/g;

// keep track of whether or not the locale data has already been emitted
var localeDataEmitted;

/**
 * Produce a set of js files that contain the necessary
 * locale data. These files are output into js files, one
 * per locale part, that each export a function that adds
 * data for that locale part to the ilib.data structure.
 * For example, the locale "en-US" has the following parts:
 *
 * <ul>
 * <li><i>root</i> - shared by all locales, containing
 * generic locale data and most non-locale data.
 * <li><i>en</i> - language-specific data shared by all
 * of the English locales. Example: date formats
 * <li><i>und-US</i> - region-specific data shared by
 * all languages in the same region. Example: default
 * time zone or standard currency
 * <li><i>en-US</i> - language- and region-specific
 * information that overrides the above information.
 * </ul>
 *
 * Ilib knows to load the locale data parts in the right
 * order such that the more specific data overrides
 * the less specific data.
 *
 * @param compilation the webpack compilation
 * @param options the options for this loader from
 * the webpack.config.js
 * @returns {Array.<string>} an array of files that
 * were emitted by this function
 */
function emitLocaleData(compilation, options) {
    if (localeDataEmitted) {
        return localeDataEmitted;
    }

    var outputFileName, output;
    var scripts = new Set();
    var normalizations = {};
    var outputDir = path.resolve(options && path.isAbsolute(options.tempDir) ? options.tempDir : path.join(process.cwd(), options.tempDir || 'assets'));
    var sources = {};

    var charsets = new Set();
    var charmaps = {};
    var lang2charset;
    var outputSet = {};
    var match;
    var root = options.ilibRoot || findIlibRoot();
    var dataRoot = calcDataRoot(options);
    var manifest = new Set(); // list of all locale data files that were processed

    var locales = options.locales;
    locales.forEach(function(locale) {
        var lm = new LocaleMatcher({locale: locale});
        var full = lm.getLikelyLocale();
        if (full.getScript()) {
            scripts.add(full.getScript());
        }
    });
    if (options.debug) console.log("ilib-webpack-plugin: emitting locale data for locales " + locales.join(","));

    locales.forEach(function(locale) {
        localeData.forEach(function(filename) {
            normPattern.lastIndex = 0;
            if (filename === "charset" || filename === "charmaps") {
                // charmaps and charset info are special cases because they are non-locale data.
                // If they just use the generic "charset" or "charmaps" data, then
                // we figure out which charsets are appropriate for the locale
                if (!lang2charset) {
                    var fileName = path.join(dataRoot, "lang2charset.json");

                    if (fileName[0] !== '/' && fileName[0] !== '.' ) {
                        fileName = "./" + fileName;
                    }
                    lang2charset = require(fileName);
                }

                var l = new Locale(locale);
                var spec = l.getLanguage() + (l.getScript() ? ("-" + l.getScript()) : ""); // TODO: should use l.getLangScript()
                if (lang2charset[spec]) {
                    // always add the charset, even when charmaps are requested, because the
                    // charmaps need the charset for the charmap
                    lang2charset[spec].forEach(function(charsetName) {
                        charsets.add(charsetName);
                    });

                    if (filename === "charmaps") {
                        if (!charmaps[spec]) {
                            charmaps[spec] = new Set();
                        }
                        lang2charset[spec].forEach(function(charsetName) {
                            charmaps[spec].add(charsetName);
                        });
                    }
                }
            } else if ((match = normPattern.exec(filename)) !== null) {
                var form = match[1];
                if (!normalizations[form]) {
                    normalizations[form] = new Set();
                }
                if (match.length > 3) {
                    normalizations[form].add(match[3] || "");
                }
            } else if (filename === "zoneinfo") {
                // time zone data in the zoneinfo files are a special case because they are non-locale data
                // console.log(">>>>>>>>>>>>> processing zoneinfo. cwd is " + process.cwd());
                var cwdToData = path.join(dataRoot, "zoneinfo/zonetab.json");
                var data = fs.readFileSync(cwdToData, "utf-8");
                var zonetab = JSON.parse(data);
                // console.log(">>>>>>>>>>>>> got zone tab.");
                var line = 'ilib.data.zoneinfo.zonetab = ' + data + ';\n';
                if (!outputSet.root) {
                    outputSet.root = {};
                }
                outputSet.root.zonetab = line;
                manifest.add("zoneinfo/zonetab.json");

                var regionSet = new Set();
                locales.forEach(function(locale) {
                    regionSet.add(new Locale(locale).region);
                });
                var zoneSet = new Set();
                regionSet.forEach(function(region) {
                    if (zonetab[region]) {
                        zonetab[region].forEach(function(zone) {
                            zoneSet.add(zone);
                        });
                    }
                });
                zoneSet.forEach(function(zone) {
                    try {
                        var cwdToData = path.join(dataRoot, "zoneinfo", zone + ".json");
                        if (fs.existsSync(cwdToData)) {
                            data = fs.readFileSync(cwdToData, "utf-8");
                            var line = 'ilib.data.zoneinfo["' + zone.replace(/-/g, "m").replace(/\+/g, "p") + '"] = ' + data + ';\n';
                            // console.log(">>>>>>>>>>>>> Adding zone: " + line);
                            outputSet.root[zone] = line;
                            manifest.add(path.join("zoneinfo", zone + ".json"));
                        }
                    } catch (e) {
                        console.log("ilib-webpack-plugin: Error: " + e);
                    }
                }.bind(this));

                // now add the generic zones
                var zoneinfoDir = path.join(dataRoot, "zoneinfo");
                var list = fs.readdirSync(zoneinfoDir);
                list = list.concat(fs.readdirSync(path.join(zoneinfoDir, "Etc")).map(function(zone) {
                    return "Etc/" + zone;
                }));

                list.filter(function(pathname) {
                    return pathname.endsWith(".json") && pathname !== "zonetab.json";
                }).forEach(function (file) {
                    var zone = path.basename(file, ".json");
                    var cwdToData = path.join(dataRoot, "zoneinfo", file);
                    data = fs.readFileSync(cwdToData, "utf-8");
                    var line = 'ilib.data.zoneinfo["' + zone.replace(/-/g, "m").replace(/\+/g, "p") + '"] = ' + data + ';\n';
                    // console.log(">>>>>>>>>>>>> Adding generic zone: " + line);
                    // compiler.addDependency(cwdToData);
                    outputSet.root[zone] = line;
                    manifest.add(path.join("zoneinfo", file));
                }.bind(this));
            } else {
                var l = new Locale(locale);

                var parts = [
                    ".",
                    l.language
                    ];

                if (l.script) {
                    parts.push(l.language + "/" + l.script);
                    if (l.region) {
                        parts.push(l.language + "/" + l.script + "/" + l.region);
                    }
                }
                if (l.region) {
                    parts.push(l.language + "/" + l.region);
                    parts.push("und/" + l.region);
                }

                parts.forEach(function(localeDir) {
                    try {
                        var cwdToData = path.join(dataRoot, localeDir, filename + ".json");
                        var part = localeDir === "." ? "root" : localeDir;
                        part = part.replace(/\//g, "-");
                        if (!outputSet[part]) {
                            outputSet[part] = {};
                        }
                        if (fs.existsSync(cwdToData)) {
                            if (!outputSet[part][filename]) {
                                var line = "ilib.data." + toIlibDataName(filename);
                                if (part !== "root") {
                                    line += "_" + toIlibDataName(part);
                                }
                                data = fs.readFileSync(cwdToData, "utf-8");
                                line += " = " + data + ";\n";
                                // console.log(">>>>>>>>>>>>> Adding line: " + line);

                                outputSet[part][filename] = line;
                                manifest.add(path.join(localeDir, filename + ".json"));
                            }
                        } else {
                            outputSet[part][filename] = "";
                            manifest.add(path.join(localeDir, filename + ".json"));
                        }
                    } catch (e) {
                        console.log("ilib-webpack-plugin: Error: " + e);
                    }
                }.bind(this));
            }
        });
    }.bind(this));

    if (charsets.size > 0) {
        var optional = new Set();

        if (!outputSet.root) {
            outputSet.root = {};
        }
        var data, cwdToData = path.join(dataRoot, "charsetaliases.json");
        if (!outputSet.root.charsetaliases && fs.existsSync(cwdToData)) {
            data = fs.readFileSync(cwdToData, "utf-8");
            var line = "ilib.data.charsetaliases = " + data + ";\n";
            outputSet.root.charsetaliases = line;
            manifest.add("charsetaliases.json");
        }

        charsets.forEach(function(charset) {
            var data, cwdToData = path.join(dataRoot, "charset", charset + ".json");
            filename = "charset_" + charset;
            if (!outputSet.root[filename] && fs.existsSync(cwdToData)) {
                data = fs.readFileSync(cwdToData, "utf-8");
                var line = "ilib.data.charset_" + toIlibDataName(charset) + " = " + data + ";\n";
                outputSet.root[filename] = line;
                manifest.add(path.join("charset", charset + ".json"));

                var cs = JSON.parse(data);
                if (typeof(cs.optional) === "boolean" && cs.optional) {
                    optional.add(charset);
                }
            }
        });

        for (var locale in charmaps) {
            var loc = (locale === "*" ? "root" : locale);
            charmaps[locale].forEach(function(charset) {
                var data, cwdToData = path.join(dataRoot, "charmaps", charset + ".json");
                filename = "charmaps_" + charset;
                if (!optional.has(charset) && !outputSet.root[filename] && fs.existsSync(cwdToData)) {
                    data = fs.readFileSync(cwdToData, "utf-8");
                    var line = "ilib.data.charmaps_" + toIlibDataName(charset) + " = " + data + ";\n";
                    outputSet.root[filename] = line;
                    manifest.add(path.join("charmaps", charset + ".json"));
                }
            });
        }
    }

    function addForm(form, script) {
        if (script) {
            try {
                var cwdToData = path.join(dataRoot, form, script + ".json");
                if (fs.existsSync(cwdToData)) {
                    data = fs.readFileSync(cwdToData, "utf-8");
                    var line = '// form ' + form + ' script ' + script + '\nilib.extend(ilib.data.norm.' + form + ', ' + data + ');\n';
                    // console.log(">>>>>>>>>>>>> Adding form: " + form);
                    outputSet.root[form + "/" + script] = line;
                    manifest.add(path.join(form, script + ".json"));
                }
            } catch (e) {
                console.log("ilib-webpack-plugin: Error: " + e);
            }
        }
    }

    for (var form in normalizations) {
        if (normalizations[form].has("all")) {
            // if "all" is there, then we don't need to add each script individually
            // because they are all in the all.json already
            addForm(form, "all");
        } else {
            var set = (normalizations.size === 0 || (normalizations[form].has("") && normalizations.size === 1)) ? scripts : normalizations[form];
            set.forEach(function(script) {
                if (options.debug) console.log("ilib-webpack-plugin: Including " + form + " for script " + script);
                addForm(form, script);
            });
        }
    }

    // Write out the manifest file so that the WebpackLoader knows when to attempt
    // to load data and when not to. If a file it is attempting to load is not in
    // the manifest, it does not have to load the locale files that would contain it,
    // which leads to 404s. The ilibmanifest.json is used locally when running under
    // nodejs, and the ilibmanifest.js is used remotely when running in a browser.
    var localManifest =  {
        files: toArray(manifest)
    };
    var outputPath = path.join(outputDir, "locales"),
    outputFile = path.join(outputPath, "localmanifest.js");
    makeDirs(outputPath);
    if (options.debug) console.log("ilib-webpack-plugin: Emitting local manifest " + outputFile);
    var text = "module.exports=" + JSON.stringify(localManifest) + ";\n";
    sources[outputFile] = text;
    makeDirs(outputPath);
    fs.writeFileSync(outputFile, text, "utf-8");

    var remoteManifest = {
        files: Object.keys(outputSet).map(function(file) {
            return file + ".js";
        })
    };
    outputFile = path.join(outputPath, "remotemanifest.js");
    if (options.debug) console.log("ilib-webpack-plugin: Emitting remote manifest " + outputFile);
    text = "module.exports=" + JSON.stringify(remoteManifest) + ";\n";
    sources[outputFile] = text;
    fs.writeFileSync(outputFile, text, "utf-8");

    for (var filename in outputSet) {
        var outputFileName = filename + ".js";
        var dataFiles = outputSet[filename];
        var ilibRoot = options.ilibRoot ?
            path.join(options.ilibRoot, "lib/ilib.js") :
                "ilib/lib/ilib.js";

        var output = "module.exports.installLocale = function(ilib) {\n";

        for (var dataFile in dataFiles) {
            output += dataFiles[dataFile];
        }

        output += "};\n";


        var outputFile = path.join(outputPath, outputFileName);
        if (options.debug) console.log("ilib-webpack-plugin: Emitting " + outputFile + " size " + output.length);
        // if (options.debug) console.log("ilib-webpack-plugin: Writing to " + outputFile);
        makeDirs(path.dirname(outputFile));
        fs.writeFileSync(outputFile, output, "utf-8");
        sources[outputFile] = output;   // remember this so we can update the in-memory modules later
    }

    // console.log("ilib-webpack-plugin: Done emitting locale data.");
    localeDataEmitted = sources;

    return sources;
};

function IlibDataPlugin(options) {
    this.options = options || {};

    loadIlibClasses(options.ilibRoot);

    this.name = "IlibWebpackPlugin";
}

IlibDataPlugin.prototype.apply = function(compiler) {
    // Webpack 4
    if (compiler.hooks) {
        compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
            compilation.ilibWebpackPlugin = this; // make sure the ilib webpack loaders can find this plugin

            compilation.hooks.finishModules.tap(PLUGIN_NAME, function(modules) {
                if (localeData.size > 0) {
                    try {
                        var sources = emitLocaleData(compilation, this.options);

                        // Now update the in-memory modules with these sources because it doesn't
                        // reread the files on disk that we just wrote out.
                        modules.forEach(function(module) {
                            if (sources[module.resource]) {
                                module._source._value = '"use strict";' + sources[module.resource];
                            }
                        });
                    } catch (e) {
                        console.log("ilib-webpack-plugin: " + e.toString());
                        throw e;
                    }
                } else if (this.options.debug) {
                    console.log("ilib-webpack-plugin: not writing data: locale data is not dirty or locale data size is zero");
                }
            }.bind(this));
         });
    } else {
        compiler.plugin('compilation', function(compilation, callback) {
            compilation.ilibWebpackPlugin = this; // make sure the ilib webpack loaders can find this plugin

            compilation.plugin('finish-modules', function(modules) {
                if (localeData.size > 0) {
                    try {
                        var sources = emitLocaleData(compilation, this.options);

                        // Now update the in-memory modules with these sources because it doesn't
                        // reread the files on disk that we just wrote out.
                        modules.forEach(function(module) {
                            if (sources[module.resource]) {
                                module._source._value = '"use strict";' + sources[module.resource];
                            }
                        });
                    } catch (e) {
                        console.log("ilib-webpack-plugin: " + e.toString());
                        throw e;
                    }
                } else if (this.options.debug) {
                    console.log("ilib-webpack-plugin: not writing data: locale data is not dirty or locale data size is zero");
                }
            }.bind(this));
        }.bind(this));
    }
};

/**
 * Add a new type of locale data. The name of the type
 * is added to a set, so that the locale data is only added
 * once.
 *
 * @param {String} data the name of the data type to add
 */
IlibDataPlugin.prototype.addData = function(data) {
    if (!localeData.has(data)) {
        // clear the cache to force the locale data to be emitted again next time
        localeDataEmitted = undefined;
    }
    localeData.add(data);
};


var localeDataFiles;

/**
 * Produce a set of js files that will eventually contain
 * the necessary locale data. These files are created
 * as empty files now so that the dependency graph of the
 * compilation is correct. Then, later, the ilib webpack
 * plugin will fill in the contents of these files once
 * all other js files have been processed and we know for
 * sure what the contents should be. These js files are
 * created with one per locale part. For example, the
 * locale "en-US" has the following parts:
 *
 * <ul>
 * <li><i>root</i> - shared by all locales, containing
 * generic locale data and most non-locale data.
 * <li><i>en</i> - language-specific data shared by all
 * of the English locales. Example: date formats
 * <li><i>und-US</i> - region-specific data shared by
 * all languages in the same region. Example: default
 * time zone or standard currency
 * <li><i>en-US</i> - language- and region-specific
 * information that overrides the above information.
 * </ul>
 *
 * Ilib knows to load the locale data parts in the right
 * order such that the more specific data overrides
 * the less specific data.
 *
 * @param compilation the webpack compilation object
 * @returns {Array.<string>} an array of files that
 * were emitted by this function
 */
IlibDataPlugin.prototype.getDummyLocaleDataFiles = function(compilation) {
    // search the cache first
    if (localeDataFiles) {
        return localeDataFiles;
    }

    // not in the cache, so create the files

    var outputSet = new Set();

    var locales = this.options.locales;
    var tempDir = path.resolve(path.isAbsolute(this.options.tempDir) ? this.options.tempDir : path.join(process.cwd(), this.options.tempDir || 'assets'));

    if (this.options.debug) console.log("Creating locale data for locales " + locales.join(","));

    locales.forEach(function(locale) {
        var l = new Locale(locale);

        outputSet.add("root");
        outputSet.add(l.language);

        if (l.script) {
            outputSet.add(l.language + "-" + l.script);
            if (l.region) {
                outputSet.add(l.language + "-" + l.script + "-" + l.region);
            }
        }
        if (l.region) {
            outputSet.add(l.language + "-" + l.region);
            outputSet.add("und-" + l.region);
        }
    }.bind(this));

    // Write out the manifest file so that the WebpackLoader knows when to attempt
    // to load data and when not to. If a file it is attempting to load is not in
    // the manifest, it does not have to load the locale files that would contain it,
    // which leads to 404s.
    var files = toArray(outputSet);

    var manifestObj =  {
        files: files.map(function(name) {
            return name + ".js";
        })
    };
    var outputPath = path.join(tempDir, "locales");
    makeDirs(outputPath);
    var manifestPath = path.join(outputPath, "ilibmanifest.json");
    if (!fs.existsSync(manifestPath)) {
        if (this.options.debug) console.log("Emitting " + path.join(outputPath, "ilibmanifest.json"));
        fs.writeFileSync(manifestPath, JSON.stringify(manifestObj), "utf-8");
    }

    // now write out all the empty files

    files.forEach(function(fileName) {
        var outputFile = path.join(outputPath, fileName + ".js");
        if (this.options.debug) console.log("Creating empty file " + outputFile);
        if (!fs.existsSync(outputFile)) {
            if (this.options.debug) console.log("Writing to " + outputFile);
            makeDirs(path.dirname(outputFile));
            fs.writeFileSync(outputFile, "", "utf-8"); // write empty file
        }
    }.bind(this));

    // console.log("Done emitting locale data.");
    files = files.concat(["ilibmanifest"]);
    localeDataFiles = files;
    return files;
};

module.exports = IlibDataPlugin;


const sharp = require('sharp')
const skmeans = require("skmeans")
const potrace = require('potrace')
const convert = require('xml-js');
const rgbToHex = require('rgb-to-hex')
const { mergeXml } = require('simple-xml-merge')
const fs = require('fs/promises')
const path = require('path')
const intersect = require('path-intersection')
const pointInSvgPolygon = require('point-in-svg-polygon')
const svgPathBbox = require('svg-path-bbox')
const svgpath = require('svgpath')
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')


const main = async () => {
    let maxColors = 2
    let file = 'input.jpg'

    // command line input
    const argv = yargs(hideBin(process.argv)).argv

    maxColors = argv.colors || maxColors
    file = argv.file || file

    console.log(`Vectorizing ${file} with a maximum of ${maxColors} different colors.`)

    // cleanup the output folder
    await deleteSvgAndPngFiles('output')

    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
    console.log('image loaded')


    // transform pixel data into 3d array
    let inputPixels = []
    for (let i = 0; i < data.length; i += 3) {
        var pixel = [data[i], data[i + 1], data[i + 2]]
        inputPixels.push(pixel)
    }

    // search for clusters (groups of similar colors)
    const skmeansResult = skmeans(inputPixels, maxColors, 'kmpp')
    let centroidColors = skmeansResult.centroids.map(p => [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])])

    console.log('image colors clustered')

    // reduce colors of image to 'main' colors
    let reducedColors = skmeansResult.idxs.map(idx => centroidColors[idx])

    const buffer = Buffer.from(reducedColors.flat())
    await sharp(buffer, { raw: { width: info.width, height: info.height, channels: 3 } }).toFile('output/reduced.png')

    console.log('saved bitmap in reduced colors')

    // lets make binary maps per (not background) color
    const bgIdx = skmeansResult.idxs[0] // let's asume top-left pixel is background
    const otherIdxs = createRange(maxColors).filter(i => i != bgIdx)

    const svgs = []
    for (let i = 0; i < otherIdxs.length; i++) {
        const focusIdx = otherIdxs[i];
        const color = '#' + rgbToHex('rgb(' + centroidColors[focusIdx].join() + ')')
        const reducedColors = skmeansResult.idxs.map(idx => idx === focusIdx ? [0, 0, 0] : [255, 255, 255])
        const buffer = Buffer.from(reducedColors.flat())
        await sharp(buffer, { raw: { width: info.width, height: info.height, channels: 3 } }).toFile('output/reduced_' + focusIdx + '.png')

        console.log('saved bitmap in binary colors for idx ' + focusIdx)

        const svg = await potraceAsync('output/reduced_' + focusIdx + '.png', 'output/reduced_' + focusIdx + '.svg', {
            background: '#' + rgbToHex('rgb(' + centroidColors[bgIdx].join() + ')'),
            color: color,
            turdSize: Math.round(average([info.width, info.height])) / 20,  
            optTolerance: Math.round(average([info.width, info.height])) / 20
        })

        const svgAsObj = convert.xml2js(svg)
        const size = { width: svgAsObj.elements[0].attributes.width, height: svgAsObj.elements[0].attributes.height }

        // fix background
        const rectNode = svgAsObj.elements[0].elements.find(e => e.name === 'rect')
        rectNode.attributes.width = size.width
        rectNode.attributes.height = size.height

        // split objects
        const pathNode = svgAsObj.elements[0].elements.find(e => e.name === 'path')
        if (pathNode) {
            breakPath(pathNode, i, color);
        }

        const txt = convert.js2xml(svgAsObj)
        svgs.push('<?xml>' + txt)
    }

    console.log('Save merged svgs')
    const others = [...svgs]
    others.shift()

    const mergedXml = mergeXml(svgs[0], others)
    await fs.writeFile('output/vectorized.svg', mergedXml.replace('<?xml ?>', ''))
}

const deleteSvgAndPngFiles = async (directory) => {
      const files = await fs.readdir(directory)
      for (const file of files) {
        const filePath = path.join(directory, file)
        const fileExtension = path.extname(file)
  
        // Check if the file is an SVG or PNG
        if (fileExtension === '.svg' || fileExtension === '.png') {
          await fs.unlink(filePath)
        }
      }
  }

const potraceAsync = async (inFile, outFile, options) => {
    return new Promise((resolve, reject) => {
        potrace.trace(inFile, options, async function(err, svg) {
            if (err) {
                reject(err)
            }
            if (outFile) {
                await fs.writeFile(outFile, svg)
            }
            resolve(svg)
        })
    })
}

const firstPoint = (path) => {
    var position = path.split(' ', 3);
    return [parseFloat(position[1]), parseFloat(position[2])]
}

function removeCharacter(str, char) {
    return str.replace(new RegExp(char, 'g'), '')
}

function createRange(length) {
    return Array.from(Array(length).keys())
}

function average(array) {
    return array.reduce((x, y) => x + y) / array.length
}

function grow(path, expansion) {
    const bbox = svgPathBbox(path) // [x0, y0, x1, y1]

    // we calculate the center of the bbox and translate that point

    const dx = ( (Math.abs(bbox[1] - bbox[3]) / 2) + Math.min(bbox[1], bbox[3]) ) * expansion
    const dy = ( (Math.abs(bbox[0] - bbox[2]) / 2) + Math.min(bbox[0], bbox[2]) ) * expansion

    const newPath = svgpath(path).scale(1 + expansion).translate(-dx, -dy).round(3).toString()
    return newPath
}

const breakPath = (pathNode, index, color) => {
    const pathNodeD = pathNode.attributes.d;

    // break the path into multiple paths
    const subPaths = pathNodeD
        .split('M ')
        .filter(sp => sp.trim() !== '')
        .map(sp => 'M ' + sp)
        .map(i => { return { d: removeCharacter(i, ',') } })

    if (subPaths.length > 1) {
        pathNode.name = 'g';
        pathNode.attributes = { id: 'group_' + index }; // give each id so they don't merge
        pathNode.elements = [];

        for (let j = 0; j < subPaths.length; j++) {
            var subPath = subPaths[j];
            
            // run evenodd algorithm
            var testPath = 'M 0 0 L ' + firstPoint(subPath.d).join(' ')
            var intersections = 0;
            for (let k = 0; k < subPaths.length; k++) {
                if (k != j) { // don't test ourselves
                    const otherPath = subPaths[k];
                    intersections += intersect(testPath, otherPath.d, true);
                }
            }
            subPath.host = (intersections % 2 === 0)
        }

        const hosts = subPaths.filter(p => p.host).map(h => { h.hostD = h.d; h.orphansD = ''; return h });
        const orphans = subPaths.filter(p => !p.host)

        // find a host for every orphan
        for (let i = 0; i < orphans.length; i++) {
            const orphan = orphans[i]
            const potentionalHosts = hosts.filter(h => pointInSvgPolygon.isInside(firstPoint(orphan.d), h.d))
            if (potentionalHosts.length === 1) {
                // easy case
                potentionalHosts[0].d += ' ' + orphan.d
                potentionalHosts[0].orphansD += ' ' + orphan.d
                potentionalHosts[0].hasOrphans = true
            } else if (potentionalHosts.length > 1) {
                console.warn("Multiple hosts for orphan!")
            } else {
                // imposible
                console.error("Couldn't find host for orphan!")
            }
        }

        // all orphans should have a host, so only render hosts (with embedded orphans)
        for (let j = 0; j < hosts.length; j++) {
            const data = hosts[j]
            pathNode.elements.push({
                type: 'element',
                name: 'path',
                attributes: {
                    'd': grow(data.hostD, 0) + data.orphansD,
                    'stroke': 'none',
                    'fill': color,
                    'fill-rule': 'evenodd'
                }
            })
        }
        
    }
}

main()
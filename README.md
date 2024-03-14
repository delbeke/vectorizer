# Image Vectorizer Tool

## Description
This utility enables the conversion of bitmap images to SVG format with a distinct capability to restrict the color palette in the output. It intelligently aggregates same-colored elements into groups, among other beneficial functionalities. This feature is particularly advantageous for projects involving AI-generated designs with a vector aesthetic, facilitating their transformation into scalable vector graphics (SVG).

## Usage
### Syntax
`node .\run.js --colors <MAX_COLORS> --file <FILENAME>`
### Example
`node .\run.js --colors 3 --file dummy.png`

## GPT
A great GPT for generating vector style images can be found here:

https://chat.openai.com/g/g-vOShw2zOc-embroidery-artist
import './sunburst.css'
import { Metafile } from './metafile'
import { showWhyFile } from './whyfile'
import {
  bytesToText,
  hasOwnProperty,
  hueAngleToColor,
  isSourceMapPath,
  lastInteractionWasKeyboard,
  now,
  setDarkModeListener,
  setResizeEventListener,
  setWheelEventListener,
  stripDisabledPathPrefix,
  textToHTML,
} from './helpers'

enum CONSTANTS {
  ANIMATION_DURATION = 350,
}

enum FLAGS {
  ROOT = 1,
  FILL = 2,
  CHAIN = 4,
  HOVER = 8,
}

interface TreeNodeInProgress {
  inputPath_: string
  bytesInOutput_: number
  children_: Record<string, TreeNodeInProgress>
}

interface TreeNode {
  inputPath_: string
  bytesInOutput_: number
  sortedChildren_: TreeNode[]
  cssColor_: string
  parent_: TreeNode | null
}

interface Tree {
  root_: TreeNode
  maxDepth_: number
}

let isParentOf = (parent: TreeNode, child: TreeNode | null): boolean => {
  while (child) {
    if (child === parent) return true
    child = child.parent_
  }
  return false
}

let orderChildrenBySize = (a: TreeNode, b: TreeNode): number => {
  return b.bytesInOutput_ - a.bytesInOutput_ || +(a.inputPath_ > b.inputPath_) - +(a.inputPath_ < b.inputPath_)
}

let analyzeDirectoryTree = (metafile: Metafile): Tree => {
  let accumulatePath = (path: string, bytesInOutput: number): void => {
    let parent = root
    root.bytesInOutput_ += bytesInOutput

    for (let part of path.split('/')) {
      let children = parent.children_
      let child = children[part]

      if (!hasOwnProperty.call(children, part)) {
        child = {
          inputPath_: parent.inputPath_ + '/' + part,
          bytesInOutput_: 0,
          children_: {},
        }
        children[part] = child
      }

      child.bytesInOutput_ += bytesInOutput
      parent = child
    }
  }

  let inputs = metafile.inputs
  let outputs = metafile.outputs
  let root: TreeNodeInProgress = { inputPath_: '', bytesInOutput_: 0, children_: {} }

  let sortChildren = (node: TreeNodeInProgress): TreeNode => {
    let children = node.children_
    let sorted: TreeNode[] = []

    for (let file in children) {
      sorted.push(sortChildren(children[file]))
    }

    sorted.sort(orderChildrenBySize)
    return {
      inputPath_: node.inputPath_,
      bytesInOutput_: node.bytesInOutput_,
      sortedChildren_: sorted,
      cssColor_: '',
      parent_: null,
    }
  }

  let setColorsAndParents = (node: TreeNode, depth: number, startAngle: number, sweepAngle: number): number => {
    let totalBytes = node.bytesInOutput_
    let bytesSoFar = 0
    let maxDepth = 0

    node.cssColor_ = hueAngleToColor(startAngle + sweepAngle / 2)
    node.parent_ = null

    for (let child of node.sortedChildren_) {
      let childDepth = setColorsAndParents(child, depth + 1, startAngle + sweepAngle * bytesSoFar / totalBytes, sweepAngle * child.bytesInOutput_ / totalBytes)
      child.parent_ = node
      bytesSoFar += child.bytesInOutput_
      if (childDepth > maxDepth) maxDepth = childDepth
    }

    return maxDepth + 1
  }

  // Include the inputs with size 0 so we can see when something has been tree-shaken
  for (let i in inputs) {
    accumulatePath(stripDisabledPathPrefix(i), 0)
  }

  // For each output file
  for (let o in outputs) {
    if (isSourceMapPath(o)) continue

    let output = outputs[o]
    let inputs = output.inputs

    // Accumulate the input files that contributed to this output file
    for (let i in inputs) {
      accumulatePath(stripDisabledPathPrefix(i), inputs[i].bytesInOutput)
    }
  }

  let finalRoot = sortChildren(root)

  // Unwrap singularly-nested root nodes
  while (finalRoot.sortedChildren_.length === 1) {
    finalRoot = finalRoot.sortedChildren_[0]
  }

  let maxDepth = setColorsAndParents(finalRoot, 0, 0, Math.PI * 2)

  return {
    root_: finalRoot,
    maxDepth_: maxDepth,
  }
}

interface Slice {
  depth_: number
  startAngle_: number
  sweepAngle_: number
}

let narrowSlice = (root: TreeNode, node: TreeNode, slice: Slice): void => {
  if (root === node) return

  let parent = node.parent_!
  let totalBytes = parent.bytesInOutput_
  let bytesSoFar = 0
  let outerRadius = computeRadius(slice.depth_ + 1)
  narrowSlice(root, parent, slice)

  for (let child of parent.sortedChildren_) {
    if (child === node) {
      slice.startAngle_ += slice.sweepAngle_ * bytesSoFar / totalBytes
      slice.sweepAngle_ = child.bytesInOutput_ / totalBytes * slice.sweepAngle_
      break
    }
    bytesSoFar += child.bytesInOutput_
  }

  slice.depth_ += 1
}

let computeRadius = (depth: number): number => {
  return 50 * 8 * Math.log(1 + Math.log(1 + depth / 8))
}

export let createSunburst = (metafile: Metafile): HTMLDivElement => {
  let componentEl = document.createElement('div')
  let mainEl = document.createElement('main')
  let tree = analyzeDirectoryTree(metafile)
  let currentNode = tree.root_
  let hoveredNode: TreeNode | null = null

  let changeCurrentNode = (node: TreeNode): void => {
    if (currentNode !== node) {
      currentNode = node
      updateSunburst()
      updateDetails()
    }
  }

  let changeHoveredNode = (node: TreeNode | null): void => {
    if (hoveredNode !== node) {
      hoveredNode = node
      updateSunburst()
      updateDetails()
    }
  }

  let startSunburst = (): () => void => {
    let canvas = document.createElement('canvas')
    let c = canvas.getContext('2d')!

    let resize = (): void => {
      let maxRadius = 2 * Math.ceil(computeRadius(tree.maxDepth_))
      let ratio = window.devicePixelRatio || 1
      width = Math.min(Math.round(innerWidth * 0.4), maxRadius)
      height = width
      centerX = width >> 1
      centerY = height >> 1
      canvas.style.width = width + 'px'
      canvas.style.height = height + 'px'
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      c.scale(ratio, ratio)
      draw()
    }

    // We want to avoid overlapping strokes from lots of really small adjacent
    // slices all merging together into a solid color. So we enforce a
    // minimum slice width of 2px and we also skip drawing slices that
    // have a tail edge less than 1.5px from the previous tail edge.
    let drawNode = (node: TreeNode, depth: number, innerRadius: number, startAngle: number, sweepAngle: number, flags: FLAGS, prevTailEdge: number): number => {
      let outerRadius = computeRadius(depth + 1)
      if (outerRadius > centerY) return prevTailEdge // Don't draw slices that fall outside the canvas bounds

      if (node === hoveredNode) {
        flags |= FLAGS.HOVER
      }

      let middleRadius = (innerRadius + outerRadius) / 2
      let tailEdge = startAngle + sweepAngle
      if (tailEdge - prevTailEdge < 1.5 / middleRadius) return prevTailEdge
      let clampedSweepAngle = 2 / middleRadius
      if (sweepAngle > clampedSweepAngle) clampedSweepAngle = sweepAngle

      // Handle the fill
      if (flags & FLAGS.FILL) {
        c.fillStyle = node.cssColor_
        c.beginPath()
        c.arc(centerX, centerY, innerRadius, startAngle, startAngle + clampedSweepAngle, false)
        c.arc(centerX, centerY, outerRadius, startAngle + clampedSweepAngle, startAngle, true)
        c.fill()
        if (hoveredNode && (flags & FLAGS.HOVER || node.parent_ === hoveredNode)) {
          c.fillStyle = 'rgba(255, 255, 255, 0.5)'
          c.fill()
        }
      }

      // Handle the stroke
      else {
        let isFullCircle = clampedSweepAngle === Math.PI * 2
        let moveToRadius = flags & FLAGS.CHAIN || isFullCircle ? outerRadius : innerRadius
        if (flags & FLAGS.ROOT && innerRadius > 0) c.arc(centerX, centerY, innerRadius, startAngle + clampedSweepAngle, startAngle, true)
        c.moveTo(centerX + moveToRadius * Math.cos(startAngle), centerY + moveToRadius * Math.sin(startAngle))
        c.arc(centerX, centerY, outerRadius, startAngle, startAngle + clampedSweepAngle, false)
        if (!isFullCircle) c.lineTo(centerX + innerRadius * Math.cos(startAngle + clampedSweepAngle), centerY + innerRadius * Math.sin(startAngle + clampedSweepAngle))
      }

      let totalBytes = node.bytesInOutput_
      let childFlags = flags & (FLAGS.FILL | FLAGS.HOVER)
      let bytesSoFar = 0
      let childTailEdge = -Infinity

      for (let child of node.sortedChildren_) {
        childTailEdge = drawNode(child, depth + 1, outerRadius, startAngle + sweepAngle * bytesSoFar / totalBytes, child.bytesInOutput_ / totalBytes * sweepAngle, childFlags, childTailEdge)
        bytesSoFar += child.bytesInOutput_
        childFlags |= FLAGS.CHAIN
      }

      return tailEdge
    }

    let draw = (): void => {
      c.clearRect(0, 0, width, height)

      // Draw the fill first
      drawNode(animatedNode, animatedDepth, computeRadius(animatedDepth), animatedStartAngle, animatedSweepAngle, FLAGS.ROOT | FLAGS.FILL, -Infinity)

      // Draw the stroke second
      c.strokeStyle = '#222'
      c.beginPath()
      drawNode(animatedNode, animatedDepth, computeRadius(animatedDepth), animatedStartAngle, animatedSweepAngle, FLAGS.ROOT, -Infinity)
      c.stroke()

      // Draw the size of the current node in the middle
      if (animatedDepth === 0) {
        c.fillStyle = '#222'
        c.font = 'bold 16px sans-serif'
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText(bytesToText(targetNode.bytesInOutput_), centerX, centerY)
      }
    }

    let START_ANGLE = -Math.PI / 2
    let width = 0
    let height = 0
    let centerX = 0
    let centerY = 0

    let animationFrame: number | null = null
    let animationStart = 0

    let sourceDepth = 0
    let sourceStartAngle = START_ANGLE
    let sourceSweepAngle = Math.PI * 2

    let targetNode = currentNode
    let targetDepth = sourceDepth
    let targetStartAngle = sourceStartAngle
    let targetSweepAngle = sourceSweepAngle

    let animatedNode = currentNode
    let animatedDepth = sourceDepth
    let animatedStartAngle = sourceStartAngle
    let animatedSweepAngle = sourceSweepAngle

    let hitTestNode = (mouseEvent: MouseEvent): TreeNode | null => {
      let visit = (node: TreeNode, depth: number, innerRadius: number, startAngle: number, sweepAngle: number): TreeNode | null => {
        let outerRadius = computeRadius(depth + 1)
        if (outerRadius > centerY) return null // Don't draw slices that fall outside the canvas bounds

        // Hit-test the current node
        if (mouseRadius >= innerRadius && mouseRadius < outerRadius) {
          let deltaAngle = mouseAngle - startAngle
          deltaAngle /= Math.PI * 2
          deltaAngle -= Math.floor(deltaAngle)
          deltaAngle *= Math.PI * 2
          if (deltaAngle < sweepAngle) {
            if (node === animatedNode) return node.parent_
            return node
          }
        }

        let totalBytes = node.bytesInOutput_
        let bytesSoFar = 0

        // Hit-test the children
        for (let child of node.sortedChildren_) {
          let hit = visit(child, depth + 1, outerRadius, startAngle + sweepAngle * bytesSoFar / totalBytes, child.bytesInOutput_ / totalBytes * sweepAngle)
          if (hit) return hit
          bytesSoFar += child.bytesInOutput_
        }

        return null
      }

      let x = mouseEvent.pageX
      let y = mouseEvent.pageY
      for (let el: HTMLElement | null = canvas; el; el = el.offsetParent as HTMLElement | null) {
        x -= el.offsetLeft
        y -= el.offsetTop
      }

      x -= centerX
      y -= centerY
      let mouseRadius = Math.sqrt(x * x + y * y)
      let mouseAngle = Math.atan2(y, x)
      return visit(animatedNode, animatedDepth, computeRadius(animatedDepth), animatedStartAngle, animatedSweepAngle)
    }

    let tick = (): void => {
      let t = (now() - animationStart) / CONSTANTS.ANIMATION_DURATION

      if (t < 0 || t > 1) {
        t = 1
        animationFrame = null
        animatedNode = targetNode
        targetDepth = 0
        targetStartAngle = START_ANGLE
        targetSweepAngle = Math.PI * 2
      } else {
        // Use a cubic "ease-in-out" curve
        if (t < 0.5) {
          t *= 4 * t * t
        } else {
          t = 1 - t
          t *= 4 * t * t
          t = 1 - t
        }
        animationFrame = requestAnimationFrame(tick)
      }

      animatedDepth = sourceDepth + (targetDepth - sourceDepth) * t
      animatedStartAngle = sourceStartAngle + (targetStartAngle - sourceStartAngle) * t
      animatedSweepAngle = sourceSweepAngle + (targetSweepAngle - sourceSweepAngle) * t

      draw()
    }

    let tooltipEl = document.createElement('div')

    let showTooltip = (x: number, y: number, html: string): void => {
      tooltipEl.style.display = 'block'
      tooltipEl.style.left = x + 'px'
      tooltipEl.style.top = y + 'px'
      tooltipEl.innerHTML = html
    }

    let hideTooltip = (): void => {
      tooltipEl.style.display = 'none'
    }

    let previousHoveredNode: TreeNode | null = null
    let historyStack: TreeNode[] = []

    resize()
    setDarkModeListener(draw)
    setResizeEventListener(resize)
    setWheelEventListener(null)

    canvas.onmousemove = e => {
      let node = hitTestNode(e)
      changeHoveredNode(node)

      // Show a tooltip for hovered nodes
      if (node && node !== animatedNode.parent_) {
        let root = tree.root_.inputPath_.length + 1
        let tooltip = node.inputPath_ + (node.sortedChildren_.length > 0 ? '/' : '')
        if (node.parent_) {
          let i = node.parent_.inputPath_.length + 1
          tooltip = textToHTML(tooltip.slice(root, i)) + '<b>' + textToHTML(tooltip.slice(i)) + '</b>'
        } else {
          tooltip = '<b>' + textToHTML(tooltip.slice(root)) + '</b>'
        }
        tooltip += ' – ' + textToHTML(bytesToText(node.bytesInOutput_))
        showTooltip(e.pageX, e.pageY + 20, tooltip)
        canvas.style.cursor = 'pointer'
      } else {
        hideTooltip()
      }
    }

    canvas.onmouseout = () => {
      changeHoveredNode(null)
      hideTooltip()
    }

    canvas.onclick = e => {
      let node = hitTestNode(e)
      if (!node) return
      hideTooltip()

      let stack: TreeNode[] = []

      // Handle clicking in the middle node
      if (node !== animatedNode.parent_) {
        stack = historyStack.concat(currentNode)
      } else if (historyStack.length > 0) {
        node = historyStack.pop()!
        stack = historyStack.slice()
      }

      if (node.sortedChildren_.length > 0) {
        changeCurrentNode(node)
        historyStack = stack
      } else {
        e.preventDefault() // Prevent the browser from removing the focus on the dialog
        showWhyFile(metafile, node.inputPath_.slice(1), node.bytesInOutput_)
      }
    }

    tooltipEl.className = 'tooltip'
    mainEl.appendChild(tooltipEl)
    mainEl.appendChild(canvas)

    return () => {
      if (previousHoveredNode !== hoveredNode) {
        previousHoveredNode = hoveredNode
        if (!hoveredNode) {
          canvas.style.cursor = 'auto'
          hideTooltip()
        }
        if (animationFrame === null) animationFrame = requestAnimationFrame(tick)
      }

      if (targetNode === currentNode) return
      historyStack.length = 0

      if (animationFrame === null) animationFrame = requestAnimationFrame(tick)
      animationStart = now()

      // Animate from parent to child
      if (isParentOf(animatedNode, currentNode)) {
        let slice: Slice = {
          depth_: animatedDepth,
          startAngle_: animatedStartAngle,
          sweepAngle_: animatedSweepAngle,
        }
        narrowSlice(animatedNode, currentNode, slice)
        animatedDepth = slice.depth_
        animatedStartAngle = slice.startAngle_
        animatedSweepAngle = slice.sweepAngle_
        targetDepth = 0
        targetStartAngle = START_ANGLE
        targetSweepAngle = Math.PI * 2
        animatedNode = currentNode
      }

      // Animate from child to parent
      else if (isParentOf(currentNode, animatedNode)) {
        let slice: Slice = {
          depth_: 0,
          startAngle_: START_ANGLE,
          sweepAngle_: Math.PI * 2,
        }
        narrowSlice(currentNode, animatedNode, slice)
        targetDepth = slice.depth_
        targetStartAngle = slice.startAngle_
        targetSweepAngle = slice.sweepAngle_
      }

      else {
        animationStart = -Infinity
        animatedNode = currentNode
      }

      sourceDepth = animatedDepth
      sourceStartAngle = animatedStartAngle
      sourceSweepAngle = animatedSweepAngle
      targetNode = currentNode
    }
  }

  let startDetails = (): () => void => {
    let detailsEl = document.createElement('div')

    let regenerate = (): void => {
      let parent = currentNode.parent_
      let children = currentNode.sortedChildren_
      let barsEl = document.createElement('div')
      let maxBytesInOutput = 1
      barsEl.className = 'bars'

      for (let child of children) {
        let bytesInOutput = child.bytesInOutput_
        if (bytesInOutput > maxBytesInOutput) maxBytesInOutput = bytesInOutput
      }

      generatedNodes.length = 0
      generatedRows.length = 0

      // Provide a link to the parent directory
      {
        let rowEl = document.createElement('a')
        rowEl.className = 'row'
        rowEl.tabIndex = 0
        barsEl.appendChild(rowEl)

        let nameEl = document.createElement('div')
        nameEl.className = 'name'
        rowEl.appendChild(nameEl)

        let sizeEl = document.createElement('div')
        sizeEl.className = 'size'
        rowEl.appendChild(sizeEl)

        // Use a link so we get keyboard support
        rowEl.href = 'javascript:void 0'
        if (parent) {
          nameEl.textContent = '../'
          rowEl.onclick = () => {
            changeCurrentNode(parent!)
            if (lastInteractionWasKeyboard && generatedRows.length > 0) {
              generatedRows[0].focus()
            }
          }
        } else {
          // Provide an empty row so that pressing enter to traverse "../"
          // repeatedly ends up being a no-op when we reach the top level.
          // We don't want users to accidentally re-descend down the tree.
          rowEl.tabIndex = -1
        }
        rowEl.onfocus = rowEl.onmouseover = () => changeHoveredNode(parent)
        rowEl.onblur = rowEl.onmouseout = () => changeHoveredNode(null)
        generatedNodes.push(parent)
        generatedRows.push(rowEl)
      }

      for (let child of children) {
        let name = child.parent_ ? child.inputPath_.slice(child.parent_.inputPath_.length + 1) : ''
        let size = bytesToText(child.bytesInOutput_)
        if (child.sortedChildren_.length > 0) name += '/'

        let rowEl = document.createElement('a')
        rowEl.className = 'row'
        rowEl.tabIndex = 0
        barsEl.appendChild(rowEl)

        let prefix = /^[^/]*\/?/.exec(name)![0]
        let nameEl = document.createElement('div')
        nameEl.className = 'name'
        nameEl.innerHTML = textToHTML(prefix) + '<span>' + name.slice(prefix.length) + '</span>'
        rowEl.appendChild(nameEl)

        let sizeEl = document.createElement('div')
        sizeEl.className = 'size'
        rowEl.appendChild(sizeEl)

        let barEl = document.createElement('div')
        barEl.className = child.bytesInOutput_ > 0 ? 'bar' : 'bar empty'
        barEl.style.background = child.cssColor_
        barEl.style.width = 100 * child.bytesInOutput_ / maxBytesInOutput + '%'
        sizeEl.appendChild(barEl)

        let bytesEl = document.createElement('div')
        bytesEl.className = 'bytes'
        bytesEl.textContent = size
        barEl.appendChild(bytesEl)

        // Use a link so we get keyboard support
        rowEl.href = 'javascript:void 0'
        rowEl.onclick = e => {
          e.preventDefault() // Prevent meta+click from opening a new tab
          if (child.sortedChildren_.length > 0) {
            changeCurrentNode(child)
            if (lastInteractionWasKeyboard && generatedRows.length > 0) {
              generatedRows[0].focus()
            }
          } else {
            showWhyFile(metafile, child.inputPath_.slice(1), child.bytesInOutput_)
          }
        }
        rowEl.onfocus = rowEl.onmouseover = () => changeHoveredNode(child)
        rowEl.onblur = rowEl.onmouseout = () => changeHoveredNode(null)
        generatedNodes.push(child)
        generatedRows.push(rowEl)
      }

      let directoryEl = document.createElement('div')
      directoryEl.className = 'dir'
      directoryEl.textContent = 'Directory: '

      let segmentsEl = document.createElement('div')
      segmentsEl.className = 'segments'
      directoryEl.appendChild(segmentsEl)

      for (let node: TreeNode | null = currentNode; node; node = node.parent_) {
        let text = node.inputPath_ + '/'
        let nodeEl = document.createElement('a')
        if (node.parent_) text = text.slice(node.parent_.inputPath_.length + 1)
        nodeEl.textContent = text
        if (node !== currentNode) {
          nodeEl.href = 'javascript:void 0'
          nodeEl.onclick = e => {
            e.preventDefault() // Prevent meta+click from opening a new tab
            changeCurrentNode(node!)
            if (lastInteractionWasKeyboard && generatedRows.length > 0) {
              // Don't focus the no-op element if it's present
              generatedRows[!generatedNodes[0] && generatedRows.length > 1 ? 1 : 0].focus()
            }
          }
        }
        segmentsEl.insertBefore(nodeEl, segmentsEl.firstChild)
      }

      detailsEl.innerHTML = ''
      detailsEl.appendChild(directoryEl)
      detailsEl.appendChild(barsEl)
    }

    let generatedNodes: (TreeNode | null)[] = []
    let generatedRows: HTMLAnchorElement[] = []
    let previousNode = currentNode
    let previousHoveredNode: TreeNode | null = null
    let previousHoveredElement: HTMLAnchorElement | null = null

    detailsEl.className = 'details'
    mainEl.appendChild(detailsEl)
    regenerate()

    return () => {
      if (previousNode !== currentNode) {
        previousNode = currentNode
        regenerate()
      }

      if (previousHoveredNode !== hoveredNode) {
        previousHoveredNode = hoveredNode

        if (previousHoveredElement) {
          previousHoveredElement.classList.remove('hover')
          previousHoveredElement = null
        }

        for (let node: TreeNode | null = hoveredNode; node; node = node.parent_) {
          let index = generatedNodes.indexOf(node)
          if (index >= 0) {
            previousHoveredElement = generatedRows[index]
            previousHoveredElement.classList.add('hover')
            break
          }
        }
      }
    }
  }

  let updateSunburst = startSunburst()
  let updateDetails = startDetails()

  componentEl.id = 'sunburstPanel'
  componentEl.innerHTML = ''
    + '<div class="summary">'
    + '<p>'
    + 'This visualization shows how much space each input file takes up in the final bundle. '
    + 'Input files that take up 0 bytes have been completely eliminated by tree-shaking.'
    + '</p>'
    + '</div>'
  componentEl.appendChild(mainEl)
  return componentEl
}

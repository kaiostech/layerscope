/* vim:set ts=2 sw=2 sts=2 et: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

if (typeof LayerWorker == "undefined" || !LayerWorker) {
  LayerWorker = {};
}

onmessage = function (event) {
  if (!!event.data.pbuffer) {
    LayerWorker.PBDataProcesser.handle(event.data.pbuffer);
  }
  if(!!event.data.command) {
    LayerWorker.PBDataProcesser[event.data.command]();
  }
};

// Move LayerWorker.PBDataProcesser back to main thread is rather eaiser
// for debugging.
// To achieve it, you need to
// 1. set LayerWorker.MainThread as true.
// 2. include this js in layerview.html
//    <script type="application/javascript;version=1.8" src="js/dataprocesser_worker.js">
//    </script>
//    !! Make sure include dataprocesser_worker.js before dataprocesser_proxy.js!!
// Only do this for debugging purpose, move data-parsing back to main thread
// will increase the loading of main thread and slow down UI response.
LayerWorker.MainThread = false;

if (LayerWorker.MainThread) {
  LayerWorker.PBPacket = dcodeIO.ProtoBuf
    .loadProtoFile("js/protobuf/LayerScopePacket.proto")
    .build("mozilla.layers.layerscope.Packet")
    ;

    LayerWorker.OnMessage = onmessage;
} else {
  importScripts('../lib/protobuf/Long.js');
  importScripts('../lib/protobuf/ByteBufferAB.js');
  importScripts('../lib/protobuf/ProtoBuf.js');
  importScripts('../lib/lz4-decompress.js');
  importScripts('../lib/sha1.js');
  importScripts('common.js');
  importScripts('frame.js');
  importScripts('displaylist.js');

  LayerWorker.PBPacket = dcodeIO.ProtoBuf
    .loadProtoFile("./protobuf/LayerScopePacket.proto")
    .build("mozilla.layers.layerscope.Packet")
    ;
}

LayerWorker.PBDataProcesser = {
  _activeFrame: null,

  /*
   * Handle "End" command. Clean all datas.
   */
  end: function PBP_end() {
    LayerWorker.TexBuilder.end();
    this._activeFrame = null;
  },

  /*
   * Use veried builder to convert sender protocol buffer pacakges into frames.
   * Renderers in layerscope represent frames which are produced here with
   * different ways.
   */
  handle: function PDP_handle(data) {
    var pbuffer = LayerWorker.PBPacket.decode(data);
    switch(pbuffer.type) {
      case LayerWorker.PBPacket.DataType.FRAMESTART:
        this._beginFrame({low: pbuffer.frame.value.getLowBitsUnsigned(),
                          high: pbuffer.frame.value.getHighBitsUnsigned()});
        this._activeFrame.myFrameStamp = pbuffer.frame.value.toString();
        this._activeFrame.scale = pbuffer.frame.scale || 1.0;
        break;
      case LayerWorker.PBPacket.DataType.FRAMEEND:
        if (!!this._activeFrame) {
          this._endFrame();
        }
        break;
      case LayerWorker.PBPacket.DataType.COLOR:
        if (pbuffer.color != null && !!this._activeFrame) {
          this._activeFrame.colors.push(LayerWorker.ColorBuilder.build(pbuffer.color));
        }
        break;
      case LayerWorker.PBPacket.DataType.TEXTURE:
        if (pbuffer.texture != null && !!this._activeFrame) {
          this._activeFrame.textureNodes.push(LayerWorker.TexBuilder.build(pbuffer.texture));
        }
        break;
      case LayerWorker.PBPacket.DataType.LAYERS:
        if (pbuffer.layers != null && !!this._activeFrame) {
          this._activeFrame.layerTree =  LayerWorker.LayerTreeBuilder.build(pbuffer.layers);
        }
        break;
      case LayerWorker.PBPacket.DataType.META:
        // Skip META
        break;
      case LayerWorker.PBPacket.DataType.DRAW:
        if (pbuffer.draw != null && !!this._activeFrame) {
          this._activeFrame.draws.push(LayerWorker.DrawBuilder.build(pbuffer.draw));
        }
        break;
      default:
        console.assert(false, "Error: Unsupported packet type(" +
                               pbuffer.type +
                               "). Please update this viewer.");
    }
  },

  _beginFrame: function PDP_beginFrame(stamp) {
    // Ideally, sender should send paired FRAMESTART-FRAMEEND message.
    if (!!this._activeFrame) {
        console.assert(false, "Error: Receive an unpaired frame message.");
        this._endFrame();
    }

    this._activeFrame = new LayerScope.Frame(stamp);
  },

  _endFrame: function PDP_endFrame() {
    // Skip unpaired frame.
    if (!this._activeFrame) {
      console.assert(!!this._activeFrame);
    }

    // message
    var message = {frame: this._activeFrame,
                   images: LayerWorker.TexBuilder.transferImages()};
    // transferable list
    var transferables = [];
    for (var key in message.images) {
      if (message.images.hasOwnProperty(key)) {
        transferables.push(message.images[key].data.buffer);
      }
    }

    if (LayerWorker.MainThread) {
      LayerScope.ProtoDataProcesserProxy.receiveMessage({data: message});
    } else {
      // post message and transferable list.
      postMessage(message, transferables);
    }

    // clear active frame.
    this._activeFrame = null;
  },
};

/*
 *  Build a node which contains information of a color sprite.
 */
LayerWorker.ColorBuilder = {
  build: function CB_build(pcolor) {
    return {
      type: "Color",
      color: pcolor.color,
      width: pcolor.width,
      height: pcolor.height,
      layerRef: {low: pcolor.layerref.getLowBitsUnsigned(),
                 high: pcolor.layerref.getHighBitsUnsigned()}
    };
  }
};

/*
 *  Build a node which contains information of a texture sprite.
 */
LayerWorker.TexBuilder = {
  // Hold hash/image map for a single frame session.
  _images: {},
  // Hold hash for a whole profile session.
  _keys: [],
  _contentMap:[],

  /**
   * Hanlde "End" command.
   */
  end: function TB_end() {
    this._images = {};
    this._keys = [];
    this._contentMap = [];
  },

  build: function TB_build(ptexture) {
    //  Create a texture node
    var layerRef = {
      low: ptexture.layerref.getLowBitsUnsigned(),
      high: ptexture.layerref.getHighBitsUnsigned()
    };
    // No image data means the content of this texture is not altered
    if (!ptexture.data) {
      for (var i = 0; i < this._contentMap.length; i++) {
        var element = this._contentMap[i];
        if (this._contentMap[i].name == ptexture.name) {
          var node = new LayerScope.TextureNode(ptexture,
                                                this._contentMap[i].key,
                                                layerRef,
                                                false);

          return node
        }
      }

      return null;
    }

    // New content.
    var key = this._cache(
      new Uint8Array(ptexture.data.buffer).subarray(ptexture.data.offset, ptexture.data.limit),
      ptexture.width,
      ptexture.height,
      ptexture.dataformat,
      ptexture.stride);

    var node = new LayerScope.TextureNode(ptexture, key, layerRef, true);

    // Update content map.
    for (var i = 0; i < this._contentMap.length; i++) {
      if (this._contentMap[i].name == ptexture.name) {
        this._contentMap[i].key = key;
        break;
      }
    }
    if (i == this._contentMap.length) {
      this._contentMap.push({name: ptexture.name, key: key});
    }

    return node;
  },

  _cache: function TB_cache(source, width, height, format, stride) {
    var hash = sha1.hash(source);

    if (width == 0 || height == 0) {
      console.log("Viewer receive invalid texture info.");
      return null;
    }

    //  Cache matchs.
    if (-1 != this._keys.indexOf(hash)) {
      return hash;
    }

    // Generate a new cache image for this source.
    if ((format >> 16) & 1) {
      // it's lz4 compressed
      var decompressed = new Uint8Array(stride * height);
      if (0 > LZ4_uncompressChunk(source, decompressed)) {
        console.log("Error: uncompression error.");
      }
      source = decompressed;
    }

    // Create a buffer.
    var imageData = new ImageData(width, height);

    // Fill this buffer by source image.
    if (stride == width * 4) {
      imageData.data.set(source);
    } else {
      var dstData = imageData.data;
      for (var j = 0; j < height; j++) {
        for (var i = 0; i < width; i++) {
          dstData[j * width * 4 + i * 4 + 0] = source[j * stride + i * 4 + 0];
          dstData[j * width * 4 + i * 4 + 1] = source[j * stride + i * 4 + 1];
          dstData[j * width * 4 + i * 4 + 2] = source[j * stride + i * 4 + 2];
          dstData[j * width * 4 + i * 4 + 3] = source[j * stride + i * 4 + 3];
        }
      }
    }

    var LOCAL_GL_BGRA = 0x80E1;
    // BGRA to RGBA
    if ((format & 0xFFFF) == LOCAL_GL_BGRA) {
      this._BGRA2RGBA(imageData);
    }

    this._images[hash] = imageData;//{buffer: imageData.data.buffer, width: width, height: height };
    this._keys.push(hash);

    return hash;
  },

  transferImages: function IDP_transferImages() {
    var tmp = this._images;
    this._images = {};

    return tmp;
  },

  _BGRA2RGBA: function IDP_BGRA2RGBA(imageData) {
    var view = new Uint8Array(imageData.data.buffer);
    for (var pos = 0; pos < view.length; pos += 4) {
      // Software RB swap.
      var b = view[pos];
      view[pos] = view[pos + 2];
      view[pos + 2] = b;
    }
  }
};

/*
 *  Build a node which contains information of a layer.
 */
LayerWorker.LayerTreeBuilder = {
  build: function LTB_build(players) {
    var layers = Array.prototype.map.call(players.layer, layer => this._createLayerNode(layer));
    return this._buildLayerTree(layers);
  },

  _mapRegion: function LTB_mapRegion(region) {
    return Array.prototype.map.call(region, n => { return {x:n.x, y:n.y, w:n.w, h:n.h}; });
  },

  _createLayerNode: function LTB_createLayerNode(data) {
    var node = {
      type: data.type,
      ptr: {low: data.ptr.getLowBitsUnsigned(),
            high: data.ptr.getHighBitsUnsigned()},
      parentPtr: {low: data.parentPtr.getLowBitsUnsigned(),
                  high: data.parentPtr.getHighBitsUnsigned()},
      shadow: null,
      clip: !!data.clip ? {x: data.clip.x, y: data.clip.y, w: data.clip.w, h: data.clip.h} : null,
      transform: null,
      region: !!data.vRegion ? this._mapRegion(data.vRegion.r) : null,
      hitRegion: !!data.hitRegion ? this._mapRegion(data.hitRegion.r) : null,
      dispatchRegion: !!data.dispatchRegion ? this._mapRegion(data.dispatchRegion.r) : null,
      noActionRegion: !!data.noActionRegion ? this._mapRegion(data.noActionRegion.r) : null,
      hPanRegion: !!data.hPanRegion ? this._mapRegion(data.hPanRegion.r) : null,
      vPanRegion: !!data.vPanRegion ? this._mapRegion(data.vPanRegion.r) : null,
      opaque: data.cOpaque,
      alpha: data.cAlpha,
      opacity: data.opacity,
      scrollDir: data.direct,
      barID: !!data.barID ? {low: data.barID.getLowBitsUnsigned(), high: data.barID.getHighBitsUnsigned()} : null,
      mask: !!data.mask ? {low: data.mask.getLowBitsUnsigned(), high: data.mask.getHighBitsUnsigned()} : null,

      // Specific layer data
      valid: !!data.valid ? this._mapRegion(data.valid.r) : null,
      color: data.color,
      filter: data.filter,
      refID: !!data.refID ? {low: data.refID.getLowBitsUnsigned(), high: data.refID.getHighBitsUnsigned()} : null,
      size: !!data.size ? {w: data.size.w, h: data.size.h} : null
    };
    // handle shadow
    if (!!data.shadow) {
      node.shadow = {
        clip: !!data.shadow.clip ? {x: data.shadow.clip.x,
                                    y: data.shadow.clip.y,
                                    w: data.shadow.clip.w,
                                    h: data.shadow.clip.h} : null,
        transform: !!data.shadow.transform ? {is2D: !!data.shadow.transform.is2D,
                                              isID: !!data.shadow.transform.isID,
                                              m: Array.from(data.shadow.transform.m)} : null,
        region: !!data.shadow.vRegion ? this._mapRegion(data.shadow.vRegion.r) : null
      };
    }

    // handle transform
    if (!!data.transform) {
      node.transform = {
        is2D: !!data.transform.is2D,
        isID: !!data.transform.isID,
        m: Array.from(data.transform.m)
      };
    }

    // Build display list for this layer.
    if (!!data.displayListLog) {
      var compressed = new Uint8Array(data.displayListLog.buffer)
        .subarray(data.displayListLog.offset, data.displayListLog.limit)
      var decompressed = new Uint8Array(data.displayListLogLength);

      if (0 > LZ4_uncompressChunk(compressed , decompressed)) {
        console.log("Error: uncompression error.");
      } else {
        var displayListLog = String.fromCharCode.apply(null, decompressed);
        if (!!displayListLog) {
          var result = LayerScope.DisplayListBuilder.build(displayListLog);
          node.contentLayer = result[0];
          node.displayList = result[1];
        }
      }
    }

    return node;
  },

  /**
   * Move display items from the carried layer, root layer, to the target layer
   * where it draws on.
   */
  _migrateDisplayItems: function LTB_reassignDisplayItems(roots, layer) {
    var displayList = layer.value.displayList;
    if (!!displayList) {
      var name = LayerScope.LayerNameMap[layer.value.type];
      // Dispatch display list hosted in this layer to painted layers.
      if (name == "ContainerLayer" || name == "RefLayer") {
        (function iterateItem(item) {
          var removeItems = [];
          for (var child of item.children) {
            if (!child.layer) {
              removeItems.push(child);
              if (!!child.children) {
                iterateItem(child);
              }

              continue;
            }

            var targetLayer = LayerScope.FrameUtils
                                .findLayerByContentLayerID(roots, child.layer);
            if (!!targetLayer && targetLayer != layer) {
              // Move this display item to the correct hosted layer.
              var root = targetLayer.value.displayList ||
                              (targetLayer.value.displayList =
                               new LayerScope.DisplayRoot());
              root.children.push(child);
              child.displayItemParent = root;
              removeItems.push(child)
            }

            iterateItem(child);
          }

          // Remove items from the current hosted layer.
          for (var removed of removeItems) {
            var index = item.children.indexOf(removed);
            item.children.splice(index, 1);
          }
        })(displayList);
      }
    }

    // Top down approach.
    for (var child of layer.children) {
      this._migrateDisplayItems(roots, child);
    }
  },

  _reIndex: function LTB_reIndex(layer) {
    if (layer.value.displayList) {
      LayerScope.DisplayItem.reIndex(layer.value.displayList);
    }

    for (var child of layer.children) {
      this._reIndex(child);
    }
  },

  _buildLayerTree: function LTB_buildLayerTree(nodeList) {
    var roots = [];
    var children = {}; // hash table: parent address -> children array

    // TreeNode Construct
    var treeNode = function(property) {
      this.value = property;
      this.children = [];
    };

    for (var item of nodeList) {
      var p = item.parentPtr.low;
      var target = !p ? roots : (children[p] || (children[p] = []));
      target.push(new treeNode(item));
    }

    // DFS traverse by resursion
    var findChildren = function(papa){
      if (children[papa.value.ptr.low]) {
        papa.children = children[papa.value.ptr.low];
        for (var ch of papa.children) {
          findChildren(ch);
        }
      }
    };

    for (var root of roots) {
      findChildren(root);
    }

    for (var root of roots) {
      this._migrateDisplayItems(roots, root);
    }

    for (var root of roots) {
      this._reIndex(root);
    }

    return roots;
  },
};

/*
 *  Build a node which contains information of a draw call.
 */
LayerWorker.DrawBuilder = {
  build: function CB_build(pdraw) {
    return {
      layerRef: {
        low: pdraw.layerref.getLowBitsUnsigned(),
        high: pdraw.layerref.getHighBitsUnsigned()
      },
      offsetX: pdraw.offsetX,
      offsetY: pdraw.offsetY,
      mvMatrix: pdraw.mvMatrix,
      totalRects: pdraw.totalRects,
      layerRect: pdraw.layerRect,
      textureRect: pdraw.textureRect,
      texIDs: pdraw.texIDs
    };
  }
};

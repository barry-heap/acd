// This is a generated file! Please edit source .ksy file and use kaitai-struct-compiler to rebuild

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports', 'kaitai-struct/KaitaiStream'], factory);
  } else if (typeof exports === 'object' && exports !== null && typeof exports.nodeType !== 'number') {
    factory(exports, require('kaitai-struct/KaitaiStream'));
  } else {
    factory(root.RxGeneric || (root.RxGeneric = {}), root.KaitaiStream);
  }
})(typeof self !== 'undefined' ? self : this, function (RxGeneric_, KaitaiStream) {
var RxGeneric = (function() {
  function RxGeneric(_io, _parent, _root) {
    this._io = _io;
    this._parent = _parent;
    this._root = _root || this;

    this._read();
  }
  RxGeneric.prototype._read = function() {
    this.parentId = this._io.readU4le();
    this.uniqueTagIdentifier = this._io.readU4le();
    this.recordFormatVersion = this._io.readU2le();
    this.cipType = this._io.readU2le();
    this.commentId = this._io.readU2le();
    switch (this.cipType) {
    case 104:
      this._raw_mainRecord = this._io.readBytes(60);
      var _io__raw_mainRecord = new KaitaiStream(this._raw_mainRecord);
      this.mainRecord = new RxTag(_io__raw_mainRecord, this, this._root);
      break;
    case 107:
      this._raw_mainRecord = this._io.readBytes(60);
      var _io__raw_mainRecord = new KaitaiStream(this._raw_mainRecord);
      this.mainRecord = new RxTag(_io__raw_mainRecord, this, this._root);
      break;
    default:
      this._raw_mainRecord = this._io.readBytes(60);
      var _io__raw_mainRecord = new KaitaiStream(this._raw_mainRecord);
      this.mainRecord = new Unknown(_io__raw_mainRecord, this, this._root);
      break;
    }
    this.lenRecord = this._io.readU4le();
    this.countRecord = this._io.readU4le();
    this.extendedRecords = [];
    for (var i = 0; i < this.countRecord - 1; i++) {
      this.extendedRecords.push(new AttributeRecord(this._io, this, this._root));
    }
  }

  var AttributeRecord = RxGeneric.AttributeRecord = (function() {
    function AttributeRecord(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    AttributeRecord.prototype._read = function() {
      this.attributeId = this._io.readU4le();
      this.lenValue = this._io.readU4le();
      this.value = this._io.readBytes(this.lenValue);
    }

    return AttributeRecord;
  })();

  var LastAttributeRecord = RxGeneric.LastAttributeRecord = (function() {
    function LastAttributeRecord(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    LastAttributeRecord.prototype._read = function() {
      this.attributeId = this._io.readU4le();
      this.lenValue = this._io.readU4le();
      this.value = this._io.readBytes(this.lenValue - 4);
    }

    return LastAttributeRecord;
  })();

  var RxMapDevice = RxGeneric.RxMapDevice = (function() {
    function RxMapDevice(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    RxMapDevice.prototype._read = function() {
    }
    Object.defineProperty(RxMapDevice.prototype, 'moduleId', {
      get: function() {
        if (this._m_moduleId !== undefined)
          return this._m_moduleId;
        var _pos = this._io.pos;
        this._io.seek(36);
        this._m_moduleId = this._io.readU4le();
        this._io.seek(_pos);
        return this._m_moduleId;
      }
    });
    Object.defineProperty(RxMapDevice.prototype, 'parentModule', {
      get: function() {
        if (this._m_parentModule !== undefined)
          return this._m_parentModule;
        var _pos = this._io.pos;
        this._io.seek(22);
        this._m_parentModule = this._io.readU4le();
        this._io.seek(_pos);
        return this._m_parentModule;
      }
    });
    Object.defineProperty(RxMapDevice.prototype, 'productCode', {
      get: function() {
        if (this._m_productCode !== undefined)
          return this._m_productCode;
        var _pos = this._io.pos;
        this._io.seek(6);
        this._m_productCode = this._io.readU2le();
        this._io.seek(_pos);
        return this._m_productCode;
      }
    });
    Object.defineProperty(RxMapDevice.prototype, 'productType', {
      get: function() {
        if (this._m_productType !== undefined)
          return this._m_productType;
        var _pos = this._io.pos;
        this._io.seek(4);
        this._m_productType = this._io.readU2le();
        this._io.seek(_pos);
        return this._m_productType;
      }
    });
    Object.defineProperty(RxMapDevice.prototype, 'slotNo', {
      get: function() {
        if (this._m_slotNo !== undefined)
          return this._m_slotNo;
        var _pos = this._io.pos;
        this._io.seek(32);
        this._m_slotNo = this._io.readU4le();
        this._io.seek(_pos);
        return this._m_slotNo;
      }
    });
    Object.defineProperty(RxMapDevice.prototype, 'vendorId', {
      get: function() {
        if (this._m_vendorId !== undefined)
          return this._m_vendorId;
        var _pos = this._io.pos;
        this._io.seek(2);
        this._m_vendorId = this._io.readU2le();
        this._io.seek(_pos);
        return this._m_vendorId;
      }
    });

    return RxMapDevice;
  })();

  var RxTag = RxGeneric.RxTag = (function() {
    function RxTag(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    RxTag.prototype._read = function() {
    }
    Object.defineProperty(RxTag.prototype, 'cipDataType', {
      get: function() {
        if (this._m_cipDataType !== undefined)
          return this._m_cipDataType;
        var _pos = this._io.pos;
        this._io.seek(52);
        this._m_cipDataType = this._io.readU2le();
        this._io.seek(_pos);
        return this._m_cipDataType;
      }
    });
    Object.defineProperty(RxTag.prototype, 'dataTableInstance', {
      get: function() {
        if (this._m_dataTableInstance !== undefined)
          return this._m_dataTableInstance;
        var _pos = this._io.pos;
        this._io.seek(36);
        this._m_dataTableInstance = this._io.readU4le();
        this._io.seek(_pos);
        return this._m_dataTableInstance;
      }
    });
    Object.defineProperty(RxTag.prototype, 'dataType', {
      get: function() {
        if (this._m_dataType !== undefined)
          return this._m_dataType;
        var _pos = this._io.pos;
        this._io.seek(28);
        this._m_dataType = this._io.readU4le();
        this._io.seek(_pos);
        return this._m_dataType;
      }
    });
    Object.defineProperty(RxTag.prototype, 'dimension1', {
      get: function() {
        if (this._m_dimension1 !== undefined)
          return this._m_dimension1;
        var _pos = this._io.pos;
        this._io.seek(12);
        this._m_dimension1 = this._io.readU4le();
        this._io.seek(_pos);
        return this._m_dimension1;
      }
    });
    Object.defineProperty(RxTag.prototype, 'dimension2', {
      get: function() {
        if (this._m_dimension2 !== undefined)
          return this._m_dimension2;
        var _pos = this._io.pos;
        this._io.seek(16);
        this._m_dimension2 = this._io.readU4le();
        this._io.seek(_pos);
        return this._m_dimension2;
      }
    });
    Object.defineProperty(RxTag.prototype, 'dimension3', {
      get: function() {
        if (this._m_dimension3 !== undefined)
          return this._m_dimension3;
        var _pos = this._io.pos;
        this._io.seek(20);
        this._m_dimension3 = this._io.readU4le();
        this._io.seek(_pos);
        return this._m_dimension3;
      }
    });
    Object.defineProperty(RxTag.prototype, 'externalAccess', {
      get: function() {
        if (this._m_externalAccess !== undefined)
          return this._m_externalAccess;
        var _pos = this._io.pos;
        this._io.seek(34);
        this._m_externalAccess = this._io.readU2le();
        this._io.seek(_pos);
        return this._m_externalAccess;
      }
    });
    Object.defineProperty(RxTag.prototype, 'radix', {
      get: function() {
        if (this._m_radix !== undefined)
          return this._m_radix;
        var _pos = this._io.pos;
        this._io.seek(32);
        this._m_radix = this._io.readU2le();
        this._io.seek(_pos);
        return this._m_radix;
      }
    });
    Object.defineProperty(RxTag.prototype, 'valid', {
      get: function() {
        if (this._m_valid !== undefined)
          return this._m_valid;
        this._m_valid = true;
        return this._m_valid;
      }
    });

    return RxTag;
  })();

  var Unknown = RxGeneric.Unknown = (function() {
    function Unknown(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    Unknown.prototype._read = function() {
      this.body = this._io.readBytes(60);
    }

    return Unknown;
  })();
  Object.defineProperty(RxGeneric.prototype, 'recordBuffer', {
    get: function() {
      if (this._m_recordBuffer !== undefined)
        return this._m_recordBuffer;
      var _pos = this._io.pos;
      this._io.seek(14);
      this._m_recordBuffer = this._io.readBytes(60);
      this._io.seek(_pos);
      return this._m_recordBuffer;
    }
  });

  return RxGeneric;
})();
RxGeneric_.RxGeneric = RxGeneric;
});

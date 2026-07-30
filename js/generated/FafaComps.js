// This is a generated file! Please edit source .ksy file and use kaitai-struct-compiler to rebuild

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports', 'kaitai-struct/KaitaiStream'], factory);
  } else if (typeof exports === 'object' && exports !== null && typeof exports.nodeType !== 'number') {
    factory(exports, require('kaitai-struct/KaitaiStream'));
  } else {
    factory(root.FafaComps || (root.FafaComps = {}), root.KaitaiStream);
  }
})(typeof self !== 'undefined' ? self : this, function (FafaComps_, KaitaiStream) {
var FafaComps = (function() {
  function FafaComps(_io, _parent, _root) {
    this._io = _io;
    this._parent = _parent;
    this._root = _root || this;

    this._read();
  }
  FafaComps.prototype._read = function() {
    this.recordLength = this._io.readU4le();
    this._raw_header = this._io.readBytes(144);
    var _io__raw_header = new KaitaiStream(this._raw_header);
    this.header = new Header(_io__raw_header, this, this._root);
    // NOTE: fixed vs. the raw kaitai-struct-compiler output, which read
    // (recordLength - 144) - 4. Verified against the real, validated Python
    // parser (acd/generated/comps/fafa_comps.py): record_buffer is
    // recordLength - 144, with no extra -4. See js/README.md.
    this.recordBuffer = this._io.readBytes(this.recordLength - 144);
  }

  var Header = FafaComps.Header = (function() {
    function Header(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    Header.prototype._read = function() {
    }
    Object.defineProperty(Header.prototype, 'objectId', {
      get: function() {
        if (this._m_objectId !== undefined)
          return this._m_objectId;
        var _pos = this._io.pos;
        this._io.seek(12);
        this._m_objectId = this._io.readU4le();
        this._io.seek(_pos);
        return this._m_objectId;
      }
    });
    Object.defineProperty(Header.prototype, 'parentId', {
      get: function() {
        if (this._m_parentId !== undefined)
          return this._m_parentId;
        var _pos = this._io.pos;
        this._io.seek(16);
        this._m_parentId = this._io.readU4le();
        this._io.seek(_pos);
        return this._m_parentId;
      }
    });
    Object.defineProperty(Header.prototype, 'recordName', {
      get: function() {
        if (this._m_recordName !== undefined)
          return this._m_recordName;
        var _pos = this._io.pos;
        this._io.seek(20);
        this._raw__m_recordName = this._io.readBytes(124);
        var _io__raw__m_recordName = new KaitaiStream(this._raw__m_recordName);
        this._m_recordName = new StrzUtf16(_io__raw__m_recordName, this, this._root);
        this._io.seek(_pos);
        return this._m_recordName;
      }
    });
    Object.defineProperty(Header.prototype, 'recordType', {
      get: function() {
        if (this._m_recordType !== undefined)
          return this._m_recordType;
        var _pos = this._io.pos;
        this._io.seek(6);
        this._m_recordType = this._io.readU2le();
        this._io.seek(_pos);
        return this._m_recordType;
      }
    });
    Object.defineProperty(Header.prototype, 'seqNumber', {
      get: function() {
        if (this._m_seqNumber !== undefined)
          return this._m_seqNumber;
        var _pos = this._io.pos;
        this._io.seek(4);
        this._m_seqNumber = this._io.readU2le();
        this._io.seek(_pos);
        return this._m_seqNumber;
      }
    });

    return Header;
  })();

  var StrzUtf16 = FafaComps.StrzUtf16 = (function() {
    function StrzUtf16(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    StrzUtf16.prototype._read = function() {
      this.value = KaitaiStream.bytesToStr(this._io.readBytes(2 * (this.codeUnits.length - 1)), "UTF-16LE");
      this.term = this._io.readU2le();
      if (!(this.term == 0)) {
        throw new KaitaiStream.ValidationNotEqualError(0, this.term, this._io, "/types/strz_utf_16/seq/1");
      }
    }
    Object.defineProperty(StrzUtf16.prototype, 'codeUnits', {
      get: function() {
        if (this._m_codeUnits !== undefined)
          return this._m_codeUnits;
        var _pos = this._io.pos;
        this._io.seek(this._io.pos);
        this._m_codeUnits = [];
        var i = 0;
        do {
          var _ = this._io.readU2le();
          this._m_codeUnits.push(_);
          i++;
        } while (!(_ == 0));
        this._io.seek(_pos);
        return this._m_codeUnits;
      }
    });

    return StrzUtf16;
  })();

  return FafaComps;
})();
FafaComps_.FafaComps = FafaComps;
});

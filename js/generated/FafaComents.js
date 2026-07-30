// This is a generated file! Please edit source .ksy file and use kaitai-struct-compiler to rebuild

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports', 'kaitai-struct/KaitaiStream'], factory);
  } else if (typeof exports === 'object' && exports !== null && typeof exports.nodeType !== 'number') {
    factory(exports, require('kaitai-struct/KaitaiStream'));
  } else {
    factory(root.FafaComents || (root.FafaComents = {}), root.KaitaiStream);
  }
})(typeof self !== 'undefined' ? self : this, function (FafaComents_, KaitaiStream) {
var FafaComents = (function() {
  function FafaComents(_io, _parent, _root) {
    this._io = _io;
    this._parent = _parent;
    this._root = _root || this;

    this._read();
  }
  FafaComents.prototype._read = function() {
    this.recordLength = this._io.readU4le();
    this._raw_header = this._io.readBytes(10);
    var _io__raw_header = new KaitaiStream(this._raw_header);
    this.header = new Header(_io__raw_header, this, this._root);
    switch (this.header.recordType) {
    case 1:
      this._raw_body = this._io.readBytes(this.recordLength - 10);
      var _io__raw_body = new KaitaiStream(this._raw_body);
      this.body = new AsciiRecord(_io__raw_body, this, this._root);
      break;
    case 13:
      this._raw_body = this._io.readBytes(this.recordLength - 10);
      var _io__raw_body = new KaitaiStream(this._raw_body);
      this.body = new Utf16Record(_io__raw_body, this, this._root, 12);
      break;
    case 14:
      this._raw_body = this._io.readBytes(this.recordLength - 10);
      var _io__raw_body = new KaitaiStream(this._raw_body);
      this.body = new Utf16Record(_io__raw_body, this, this._root, 12);
      break;
    case 2:
      this._raw_body = this._io.readBytes(this.recordLength - 10);
      var _io__raw_body = new KaitaiStream(this._raw_body);
      this.body = new AsciiRecord(_io__raw_body, this, this._root);
      break;
    case 23:
      this._raw_body = this._io.readBytes(this.recordLength - 10);
      var _io__raw_body = new KaitaiStream(this._raw_body);
      this.body = new ControllerRecord(_io__raw_body, this, this._root);
      break;
    case 25:
      this._raw_body = this._io.readBytes(this.recordLength - 10);
      var _io__raw_body = new KaitaiStream(this._raw_body);
      this.body = new ControllerRecord(_io__raw_body, this, this._root);
      break;
    case 3:
      this._raw_body = this._io.readBytes(this.recordLength - 10);
      var _io__raw_body = new KaitaiStream(this._raw_body);
      this.body = new Utf16Record(_io__raw_body, this, this._root, 12);
      break;
    case 4:
      this._raw_body = this._io.readBytes(this.recordLength - 10);
      var _io__raw_body = new KaitaiStream(this._raw_body);
      this.body = new Utf16Record(_io__raw_body, this, this._root, 12);
      break;
    default:
      this.body = this._io.readBytes(this.recordLength - 10);
      break;
    }
  }

  var AsciiRecord = FafaComents.AsciiRecord = (function() {
    function AsciiRecord(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    AsciiRecord.prototype._read = function() {
      this.unknown1 = this._io.readBytes(13);
      this.objectId = this._io.readU4le();
      this.unknown2 = this._io.readBytes(13);
      this.recordString = KaitaiStream.bytesToStr(this._io.readBytesTerm(0, false, true, true), "UTF-8");
    }

    return AsciiRecord;
  })();

  var AsciiRecord4 = FafaComents.AsciiRecord4 = (function() {
    function AsciiRecord4(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    AsciiRecord4.prototype._read = function() {
      this.unknown1 = this._io.readBytes(8);
      this.objectId = this._io.readU4le();
      this.unknown2 = this._io.readBytes(24);
      this.recordString = KaitaiStream.bytesToStr(this._io.readBytesTerm(0, false, true, true), "UTF-8");
    }

    return AsciiRecord4;
  })();

  var ControllerRecord = FafaComents.ControllerRecord = (function() {
    function ControllerRecord(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    ControllerRecord.prototype._read = function() {
      this.unknown1 = this._io.readBytes(8);
      this.objectId = this._io.readU4le();
      this.unknown2 = this._io.readBytes(4);
      this.tagReference = new StrzUtf16(this._io, this, this._root);
      this.unknown3 = this._io.readBytes(12);
      this.recordString = KaitaiStream.bytesToStr(this._io.readBytesTerm(0, false, true, true), "UTF-8");
    }

    return ControllerRecord;
  })();

  var Header = FafaComents.Header = (function() {
    function Header(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    Header.prototype._read = function() {
    }
    Object.defineProperty(Header.prototype, 'parent', {
      get: function() {
        if (this._m_parent !== undefined)
          return this._m_parent;
        var _pos = this._io.pos;
        this._io.seek(6);
        this._m_parent = this._io.readU4le();
        this._io.seek(_pos);
        return this._m_parent;
      }
    });
    Object.defineProperty(Header.prototype, 'recordType', {
      get: function() {
        if (this._m_recordType !== undefined)
          return this._m_recordType;
        var _pos = this._io.pos;
        this._io.seek(2);
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
        this._io.seek(0);
        this._m_seqNumber = this._io.readU2le();
        this._io.seek(_pos);
        return this._m_seqNumber;
      }
    });
    Object.defineProperty(Header.prototype, 'subRecordLength', {
      get: function() {
        if (this._m_subRecordLength !== undefined)
          return this._m_subRecordLength;
        var _pos = this._io.pos;
        this._io.seek(4);
        this._m_subRecordLength = this._io.readU2le();
        this._io.seek(_pos);
        return this._m_subRecordLength;
      }
    });

    return Header;
  })();

  var StrzUtf16 = FafaComents.StrzUtf16 = (function() {
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

  var Utf16Record = FafaComents.Utf16Record = (function() {
    function Utf16Record(_io, _parent, _root, lenUnknown3) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;
      this.lenUnknown3 = lenUnknown3;

      this._read();
    }
    Utf16Record.prototype._read = function() {
      this.unknown1 = this._io.readBytes(8);
      this.objectId = this._io.readU4le();
      this.unknown2 = this._io.readBytes(4);
      this.lenRecord = this._io.readU2le();
      this.tagReference = new StrzUtf16(this._io, this, this._root);
      this.unknown3 = this._io.readBytes(this.lenUnknown3);
      this.recordString = KaitaiStream.bytesToStr(this._io.readBytesTerm(0, false, true, true), "UTF-8");
    }

    return Utf16Record;
  })();
  Object.defineProperty(FafaComents.prototype, 'lookupId', {
    get: function() {
      if (this._m_lookupId !== undefined)
        return this._m_lookupId;
      var _pos = this._io.pos;
      this._io.seek(27);
      this._m_lookupId = this._io.readU2le();
      this._io.seek(_pos);
      return this._m_lookupId;
    }
  });
  Object.defineProperty(FafaComents.prototype, 'subRecordType', {
    get: function() {
      if (this._m_subRecordType !== undefined)
        return this._m_subRecordType;
      var _pos = this._io.pos;
      this._io.seek(41);
      this._m_subRecordType = this._io.readU2le();
      this._io.seek(_pos);
      return this._m_subRecordType;
    }
  });

  return FafaComents;
})();
FafaComents_.FafaComents = FafaComents;
});

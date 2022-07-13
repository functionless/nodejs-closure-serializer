let i = 0;

const a = global.wrapClosure(
  () => { },
  () => ({
    __filename,
    free: [{
      name: "i",
      
    }]
  })
);
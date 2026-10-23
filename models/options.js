module.exports = function schemaOptions() {
    return {
        timestamps: { createdAt: 'dateCreated', updatedAt: false },
        toJSON: {
            transform: function (doc, result) {
                delete result.__v;
                return result;
            }
        },
        toObject: {
            transform: function (doc, result) {
                delete result.__v;
                return result;
            }
        }
    };
};
